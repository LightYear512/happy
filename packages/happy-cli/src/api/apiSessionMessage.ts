/**
 * Bounded one-shot message persistence for auxiliary Happy clients.
 *
 * The public methods fix the encrypted role/content shape and use only
 * user-scoped sockets, so an auxiliary write never joins the authoritative
 * owner Socket lifecycle.
 */

import { configuration } from '@/configuration';
import { deepEqual, deterministicStringify } from '@/utils/deterministicJson';
import axios from 'axios';
import { io, type Socket } from 'socket.io-client';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { MAX_RECOVERY_RESPONSE_BYTES, RECENT_MESSAGE_WINDOW } from './sessionMessageRecovery';
import { createUserScopedMessageObserver } from './apiSessionMessageObserver';
import type { Session } from './types';

const MAX_MESSAGE_BYTES = 12_000;
const MAX_CODEX_BODY_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_ID_BYTES = 128;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_CONFIRMATION_CIPHERTEXT_BYTES = 256 * 1024;
const MAX_CODEX_BODY_DEPTH = 64;
const MAX_CODEX_BODY_NODES = 100_000;
const LOCAL_ID_PATTERN = /^xc-msg-v1-[a-f0-9]{64}$/;
const REQUEST_KEYS = new Set(['messageRole', 'messageText', 'localId', 'timeoutMs']);
const CODEX_REQUEST_KEYS = new Set(['messageRole', 'messageType', 'body', 'localId', 'timeoutMs']);

export interface UserMessageOnceRequest {
    messageRole: 'user';
    messageText: string;
    localId: string;
    timeoutMs: number;
}

export interface CodexMessageOnceRequest {
    messageRole: 'agent';
    messageType: 'codex';
    body: Record<string, unknown>;
    localId: string;
    timeoutMs: number;
}

export interface PersistedMessageReceipt {
    result: 'success';
    id: string;
    seq: number;
    localId: string;
    createdAt: number;
}

type ExpectedMessage =
    | { kind: 'user'; text: string }
    | { kind: 'codex'; body: Record<string, unknown> };

export function validateUserMessageOnceRequest(input: UserMessageOnceRequest): UserMessageOnceRequest {
    requireExactKeys(input, REQUEST_KEYS, 'user message request');
    if (input.messageRole !== 'user') throw new Error('Invalid messageRole');
    const messageBytes = typeof input.messageText === 'string' ? Buffer.byteLength(input.messageText, 'utf8') : 0;
    if (messageBytes <= 0 || messageBytes > MAX_MESSAGE_BYTES) throw new Error('Invalid messageText size');
    validateCommonRequest(input.localId, input.timeoutMs);
    return input;
}

export function validateCodexMessageOnceRequest(input: CodexMessageOnceRequest): CodexMessageOnceRequest {
    requireExactKeys(input, CODEX_REQUEST_KEYS, 'Codex message request');
    if (input.messageRole !== 'agent' || input.messageType !== 'codex') throw new Error('Invalid Codex message role or type');
    if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) throw new Error('Invalid Codex message body');
    assertStrictJsonBody(input.body);
    let serialized: string;
    try {
        serialized = deterministicStringify(input.body, { undefinedBehavior: 'throw' });
    } catch {
        throw new Error('Invalid Codex message body');
    }
    const bodyBytes = Buffer.byteLength(serialized, 'utf8');
    if (bodyBytes <= 0 || bodyBytes > MAX_CODEX_BODY_BYTES) throw new Error('Invalid Codex message body size');
    validateCommonRequest(input.localId, input.timeoutMs);
    return { ...input, body: JSON.parse(serialized) as Record<string, unknown> };
}

/** User-scoped, one-shot writer confirmed through persisted server evidence. */
export class ApiSessionMessageClient {
    private readonly session: Session;
    private readonly token: string;

    static validateRequest = validateUserMessageOnceRequest;
    static validateCodexRequest = validateCodexMessageOnceRequest;

    constructor(token: string, session: Session) {
        this.token = token;
        this.session = session;
    }

    async sendUserMessageOnce(raw: UserMessageOnceRequest): Promise<PersistedMessageReceipt> {
        const input = validateUserMessageOnceRequest(raw);
        const expected: ExpectedMessage = { kind: 'user', text: input.messageText };
        const content = {
            role: 'user',
            content: { type: 'text', text: input.messageText },
            meta: { sentFrom: 'cli' },
        };
        return this.sendOnce(input.localId, input.timeoutMs, content, expected, false);
    }

    async sendCodexMessageOnce(raw: CodexMessageOnceRequest): Promise<PersistedMessageReceipt> {
        const input = validateCodexMessageOnceRequest(raw);
        const expected: ExpectedMessage = { kind: 'codex', body: input.body };
        const content = {
            role: 'agent',
            content: { type: 'codex', data: input.body },
            meta: { sentFrom: 'cli' },
        };
        return this.sendOnce(input.localId, input.timeoutMs, content, expected, true);
    }

    private async sendOnce(
        localId: string,
        timeoutMs: number,
        content: Record<string, unknown>,
        expected: ExpectedMessage,
        observePersistedEvent: boolean,
    ): Promise<PersistedMessageReceipt> {
        const deadline = performance.now() + timeoutMs;
        let observer: Socket | null = null;
        let socket: Socket | null = null;
        let observedReceipt: PersistedMessageReceipt | null = null;
        let observedError: Error | null = null;
        try {
            const existing = await this.findPersistedMessage(localId, expected, deadline);
            if (existing) return existing;
            remaining(deadline);

            if (observePersistedEvent) {
                observer = createUserScopedMessageObserver(this.token, (data: unknown) => {
                    try {
                        const receipt = receiptFromUpdate(data, this.session.id, localId, expected, this.session);
                        if (receipt) observedReceipt = receipt;
                    } catch (error) {
                        observedError = error instanceof Error ? error : new Error('Happy message observation failed');
                    }
                });
                await this.waitForConnect(observer, remaining(deadline));
            }

            socket = this.createSocket();
            await this.waitForConnect(socket, remaining(deadline));
            const message = encodeBase64(encrypt(this.session.encryptionKey, this.session.encryptionVariant, content));
            socket.emit('message', { sid: this.session.id, message, localId });

            while (true) {
                if (observedError) throw observedError;
                if (observedReceipt) return observedReceipt;
                const persisted = await this.findPersistedMessage(localId, expected, deadline);
                if (persisted) return persisted;
                await delay(Math.min(100, remaining(deadline)));
            }
        } finally {
            socket?.close();
            observer?.close();
        }
    }

    private createSocket(): Socket {
        return io(configuration.serverUrl, {
            auth: { token: this.token, clientType: 'user-scoped' as const },
            path: '/v1/updates',
            reconnection: false,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false,
            forceNew: true,
        });
    }

    private waitForConnect(socket: Socket, timeoutMs: number): Promise<void> {
        if (socket.connected) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                socket.off('connect', onConnect);
                socket.off('connect_error', onError);
            };
            const onConnect = () => { cleanup(); resolve(); };
            const onError = () => { cleanup(); reject(new Error('Happy message socket connect failed')); };
            const timer = setTimeout(() => { cleanup(); reject(new Error('Happy message socket connect timeout')); }, timeoutMs);
            socket.once('connect', onConnect);
            socket.once('connect_error', onError);
            socket.connect();
        });
    }

    private async findPersistedMessage(
        localId: string,
        expected: ExpectedMessage,
        deadline: number,
    ): Promise<PersistedMessageReceipt | null> {
        let messages: unknown[];
        try {
            const response = await axios.get(
                `${configuration.serverUrl}/v1/sessions/${this.session.id}/messages`,
                {
                    headers: { Authorization: `Bearer ${this.token}` },
                    timeout: remaining(deadline),
                    maxContentLength: MAX_RECOVERY_RESPONSE_BYTES,
                },
            );
            if (!Array.isArray(response.data?.messages) || response.data.messages.length > RECENT_MESSAGE_WINDOW) {
                throw new Error('Happy message confirmation message collection invalid');
            }
            messages = response.data.messages;
        } catch (error) {
            if (error instanceof Error && error.message === 'Happy message confirmation message collection invalid') throw error;
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            if (typeof status === 'number' && status >= 400 && status < 500) {
                throw new Error(`Happy message confirmation rejected (${status})`);
            }
            return null;
        }
        const match = messages.find((message: unknown) => isPersistedMessage(message, localId));
        return match ? persistedReceipt(match, localId, expected, this.session) : null;
    }
}

/** Validates before constructing a Socket, including zero and overflow budgets. */
export async function sendUserMessageOnce(
    token: string,
    session: Session,
    raw: UserMessageOnceRequest,
): Promise<PersistedMessageReceipt> {
    const input = validateUserMessageOnceRequest(raw);
    return new ApiSessionMessageClient(token, session).sendUserMessageOnce(input);
}

/** Persists one exact Codex agent message without opening an owner Socket. */
export async function sendCodexMessageOnce(
    token: string,
    session: Session,
    raw: CodexMessageOnceRequest,
): Promise<PersistedMessageReceipt> {
    const input = validateCodexMessageOnceRequest(raw);
    return new ApiSessionMessageClient(token, session).sendCodexMessageOnce(input);
}

function requireExactKeys(value: unknown, expected: Set<string>, label: string): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        throw new Error(`Invalid ${label}`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.size || keys.some((key) => typeof key !== 'string' || !expected.has(key))) {
        throw new Error(`Invalid ${label} fields`);
    }
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw new Error(`Invalid ${label} fields`);
        }
    }
}

function assertStrictJsonBody(root: Record<string, unknown>): void {
    const seen = new WeakSet<object>();
    const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
    let nodes = 0;
    while (stack.length > 0) {
        const { value, depth } = stack.pop()!;
        nodes += 1;
        if (nodes > MAX_CODEX_BODY_NODES || depth > MAX_CODEX_BODY_DEPTH) {
            throw new Error('Invalid Codex message body complexity');
        }
        if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) throw new Error('Invalid Codex message body value');
            continue;
        }
        if (!value || typeof value !== 'object') throw new Error('Invalid Codex message body value');
        if (seen.has(value)) throw new Error('Invalid Codex message body cycle');
        seen.add(value);
        if (Array.isArray(value)) {
            if (value.length > MAX_CODEX_BODY_NODES) throw new Error('Invalid Codex message body complexity');
            const keys = Reflect.ownKeys(value);
            const keySet = new Set(keys);
            if (keys.length !== value.length + 1 || !keySet.has('length')) {
                throw new Error('Invalid Codex message body array');
            }
            for (let index = value.length - 1; index >= 0; index -= 1) {
                if (!keySet.has(String(index))) throw new Error('Invalid Codex message body array');
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                    throw new Error('Invalid Codex message body array');
                }
                stack.push({ value: descriptor.value, depth: depth + 1 });
            }
            continue;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) throw new Error('Invalid Codex message body object');
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== 'string') throw new Error('Invalid Codex message body key');
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                throw new Error('Invalid Codex message body property');
            }
            stack.push({ value: descriptor.value, depth: depth + 1 });
        }
    }
}

function validateCommonRequest(localId: unknown, timeoutMs: unknown): void {
    if (typeof localId !== 'string' || !LOCAL_ID_PATTERN.test(localId)) throw new Error('Invalid localId');
    if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) <= 0 || Number(timeoutMs) > MAX_TIMEOUT_MS) {
        throw new Error('Invalid timeoutMs');
    }
}

function remaining(deadline: number): number {
    const value = Math.floor(deadline - performance.now());
    if (value <= 0) throw new Error('Happy message deadline exceeded');
    return value;
}

function isPersistedMessage(value: unknown, expectedLocalId: string): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
        (value as Record<string, unknown>).localId === expectedLocalId);
}

function receiptFromUpdate(
    value: unknown,
    sessionId: string,
    localId: string,
    expected: ExpectedMessage,
    session: Session,
): PersistedMessageReceipt | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const update = value as Record<string, any>;
    if (update.body?.t !== 'new-message' || update.body.sid !== sessionId) return null;
    const message = update.body.message;
    if (!isPersistedMessage(message, localId)) return null;
    return persistedReceipt(message, localId, expected, session);
}

function persistedReceipt(
    value: Record<string, unknown>,
    expectedLocalId: string,
    expected: ExpectedMessage,
    session: Session,
): PersistedMessageReceipt {
    if (typeof value.id !== 'string' || value.id.length === 0 || Buffer.byteLength(value.id, 'utf8') > MAX_MESSAGE_ID_BYTES) {
        throw new Error('Happy message confirmation id invalid');
    }
    if (!Number.isSafeInteger(value.seq) || Number(value.seq) <= 0) throw new Error('Happy message confirmation seq invalid');
    if (!Number.isSafeInteger(value.createdAt) || Number(value.createdAt) <= 0 || Number(value.createdAt) > MAX_DATE_MS) {
        throw new Error('Happy message confirmation createdAt invalid');
    }
    if (!isExpectedMessage(value.content, expected, session)) throw new Error('Happy message confirmation payload mismatch');
    return {
        result: 'success',
        id: value.id,
        seq: Number(value.seq),
        localId: expectedLocalId,
        createdAt: Number(value.createdAt),
    };
}

function isExpectedMessage(content: unknown, expected: ExpectedMessage, session: Session): boolean {
    if (!content || typeof content !== 'object') return false;
    const envelope = content as Record<string, unknown>;
    if (envelope.t !== 'encrypted' || typeof envelope.c !== 'string' || envelope.c.length === 0 ||
        Buffer.byteLength(envelope.c, 'utf8') > MAX_CONFIRMATION_CIPHERTEXT_BYTES) return false;
    try {
        const body = decrypt(session.encryptionKey, session.encryptionVariant, decodeBase64(envelope.c));
        if (!body || typeof body !== 'object') return false;
        const record = body as Record<string, any>;
        if (expected.kind === 'user') {
            return record.role === 'user' && record.content?.type === 'text' && record.content.text === expected.text;
        }
        return record.role === 'agent' && record.content?.type === 'codex' &&
            deepEqual(record.content.data, expected.body) && record.meta?.sentFrom === 'cli';
    } catch {
        return false;
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
