import { configuration } from '@/configuration';
import { deepEqual, deterministicStringify } from '@/utils/deterministicJson';
import { stableHappySessionName } from '@/utils/happySessionName';
import axios from 'axios';
import { io, type Socket } from 'socket.io-client';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import type { Metadata, Session } from './types';

const MAX_METADATA_BYTES = 256 * 1024;
const MAX_METADATA_CIPHERTEXT_BYTES = 512 * 1024;
const MAX_METADATA_ATTEMPTS = 3;
const MAX_METADATA_DEPTH = 64;
const MAX_METADATA_NODES = 100_000;
const MAX_METADATA_TIMEOUT_MS = 120_000;

type MetadataUpdateAnswer =
    | { result: 'success'; version: number; metadata: string }
    | { result: 'version-mismatch'; version: number; metadata: string }
    | { result: 'error' };

export type ExtensibleMetadata = Metadata & Record<string, unknown>;
export type MetadataUpdater = (metadata: ExtensibleMetadata) => ExtensibleMetadata;

/** One-shot metadata writer. It deliberately does not own session lifecycle. */
export class ApiSessionMetadataClient {
    private readonly socket: Socket;
    private readonly token: string;
    private readonly sessionId: string;
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: 'legacy' | 'dataKey';
    private metadata: ExtensibleMetadata;
    private metadataVersion: number;

    constructor(token: string, session: Session) {
        this.token = token;
        this.sessionId = session.id;
        this.metadata = cloneMetadata(session.metadata as ExtensibleMetadata);
        this.metadataVersion = session.metadataVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;
        this.socket = io(configuration.serverUrl, {
            auth: { token, clientType: 'user-scoped' as const },
            path: '/v1/updates',
            reconnection: false,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false,
            forceNew: true,
        });
    }

    waitForConnect(timeoutMs: number): Promise<void> {
        validateMetadataTimeout(timeoutMs);
        if (this.socket.connected) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                this.socket.off('connect', onConnect);
                this.socket.off('connect_error', onError);
            };
            const onConnect = () => {
                cleanup();
                resolve();
            };
            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('Socket connect timeout'));
            }, timeoutMs);
            this.socket.once('connect', onConnect);
            this.socket.once('connect_error', onError);
            this.socket.connect();
        });
    }

    async updateSummaryOnce(summary: string, timeoutMs: number): Promise<{ version: number }> {
        if (typeof summary !== 'string' || Buffer.byteLength(summary, 'utf8') === 0) {
            throw new Error('Invalid metadata summary');
        }
        const updatedAt = Date.now();
        return this.updateMetadataOnce((metadata) => ({
            ...metadata,
            name: stableHappySessionName(metadata),
            summary: { text: summary, updatedAt },
        }), timeoutMs);
    }

    async updateMetadataOnce(updater: MetadataUpdater, timeoutMs: number): Promise<{ version: number }> {
        if (typeof updater !== 'function') throw new Error('Invalid metadata updater');
        validateMetadataTimeout(timeoutMs);
        const deadline = performance.now() + timeoutMs;
        let lastError: unknown = new Error('Metadata update retry exhausted');

        for (let attempt = 0; attempt < MAX_METADATA_ATTEMPTS; attempt += 1) {
            const updated = updater(cloneMetadata(this.metadata));
            assertPlainMetadata(updated);
            if (deepEqual(updated, this.metadata)) return { version: this.metadataVersion };

            try {
                await this.waitForConnect(remainingMetadataTime(deadline));
                const encryptedMetadata = encodeBase64(
                    encrypt(this.encryptionKey, this.encryptionVariant, updated),
                );
                const answer = await this.socket.timeout(remainingMetadataTime(deadline)).emitWithAck('update-metadata', {
                    sid: this.sessionId,
                    expectedVersion: this.metadataVersion,
                    metadata: encryptedMetadata,
                    claudeSessionId: typeof updated.claudeSessionId === 'string' ? updated.claudeSessionId : undefined,
                    summary: typeof updated.summary?.text === 'string' ? updated.summary.text : undefined,
                    machineId: typeof updated.machineId === 'string' ? updated.machineId : undefined,
                }) as MetadataUpdateAnswer;
                if (answer.result === 'success') {
                    if (!Number.isSafeInteger(answer.version) || answer.version !== this.metadataVersion + 1 ||
                        answer.metadata !== encryptedMetadata) {
                        throw new Error('Metadata acknowledgement version invalid');
                    }
                    this.metadata = cloneMetadata(updated);
                    this.metadataVersion = answer.version;
                    return { version: answer.version };
                }
                if (answer.result === 'error') throw new Error('Metadata update failed');
                lastError = new Error('Metadata version mismatch');
            } catch (error) {
                lastError = error;
            }

            if (attempt + 1 < MAX_METADATA_ATTEMPTS) {
                await this.refreshMetadata(deadline);
            }
        }

        throw lastError instanceof Error ? lastError : new Error('Metadata update failed');
    }

    close(): void {
        this.socket.close();
    }

    private async refreshMetadata(deadline: number): Promise<void> {
        const response = await axios.get(
            `${configuration.serverUrl}/v1/sessions/${this.sessionId}`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                },
                timeout: remainingMetadataTime(deadline),
                maxContentLength: MAX_METADATA_CIPHERTEXT_BYTES,
            },
        );
        const raw = response.data?.session;
        if (!raw || typeof raw.metadata !== 'string' || raw.metadata.length === 0 ||
            Buffer.byteLength(raw.metadata, 'utf8') > MAX_METADATA_CIPHERTEXT_BYTES ||
            !Number.isSafeInteger(raw.metadataVersion) || raw.metadataVersion < this.metadataVersion) {
            throw new Error('Metadata refresh response invalid');
        }
        const metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(raw.metadata));
        assertPlainMetadata(metadata);
        this.metadata = cloneMetadata(metadata);
        this.metadataVersion = raw.metadataVersion;
    }
}

function validateMetadataTimeout(timeoutMs: number): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_METADATA_TIMEOUT_MS) {
        throw new Error('Invalid metadata timeout');
    }
}

function remainingMetadataTime(deadline: number): number {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error('Metadata update deadline exceeded');
    return remaining;
}

function cloneMetadata(value: ExtensibleMetadata): ExtensibleMetadata {
    assertPlainMetadata(value);
    return JSON.parse(deterministicStringify(value, { undefinedBehavior: 'throw' })) as ExtensibleMetadata;
}

function assertPlainMetadata(value: unknown): asserts value is ExtensibleMetadata {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        throw new Error('Metadata must be a plain JSON object');
    }
    const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    const seen = new WeakSet<object>();
    let nodes = 0;
    while (stack.length > 0) {
        const current = stack.pop()!;
        nodes += 1;
        if (nodes > MAX_METADATA_NODES || current.depth > MAX_METADATA_DEPTH) {
            throw new Error('Invalid metadata complexity');
        }
        const item = current.value;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
        if (typeof item === 'number') {
            if (!Number.isFinite(item)) throw new Error('Metadata must be plain JSON');
            continue;
        }
        if (!item || typeof item !== 'object' || seen.has(item)) throw new Error('Metadata must be plain JSON');
        seen.add(item);
        if (Array.isArray(item)) {
            const keys = Reflect.ownKeys(item);
            if (keys.length !== item.length + 1 || !keys.includes('length')) throw new Error('Metadata must be plain JSON');
            for (let index = item.length - 1; index >= 0; index -= 1) {
                const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
                if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                    throw new Error('Metadata must be plain JSON');
                }
                stack.push({ value: descriptor.value, depth: current.depth + 1 });
            }
            continue;
        }
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) throw new Error('Metadata must be plain JSON');
        for (const key of Reflect.ownKeys(item)) {
            if (typeof key !== 'string') throw new Error('Metadata must be plain JSON');
            const descriptor = Object.getOwnPropertyDescriptor(item, key);
            if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                throw new Error('Metadata must be plain JSON');
            }
            stack.push({ value: descriptor.value, depth: current.depth + 1 });
        }
    }
    let serialized: string;
    try {
        serialized = deterministicStringify(value, { undefinedBehavior: 'throw' });
    } catch {
        throw new Error('Metadata must be plain JSON');
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) throw new Error('Invalid metadata size');
}
