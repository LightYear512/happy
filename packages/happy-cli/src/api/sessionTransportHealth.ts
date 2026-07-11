/** Atomic local lifecycle evidence for an XC-bound Happy session transport. */

import { createHash, randomUUID } from 'node:crypto';
import {
    closeSync,
    chmodSync,
    constants,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { deterministicStringify } from '@/utils/deterministicJson';

const SCHEMA = 'xc.happy-session-transport-health.v1';
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_REASON_BYTES = 512;

export type SessionTransportHealthState =
    | 'connecting'
    | 'connected'
    | 'recovering'
    | 'reconciling'
    | 'ownership_conflict'
    | 'failed'
    | 'closed';

export interface SessionTransportHealthDetail {
    reconnectCount: number;
    queueMessages: number;
    queueBytes: number;
    reason: string | null;
}

export class SessionTransportHealthReporter {
    private readonly path: string;
    private readonly directory: string;
    private readonly nativeSessionId: string;
    private readonly processStartedAt: string;
    private generation = 0;
    private connectedAt: string | null = null;
    private disconnectedAt: string | null = null;
    private lastState: SessionTransportHealthState | null = null;

    constructor(directory: string, nativeSessionId: string) {
        this.directory = directory;
        this.path = join(directory, `${nativeSessionId}.json`);
        this.nativeSessionId = nativeSessionId;
        this.processStartedAt = new Date(Date.now() - Math.floor(process.uptime() * 1_000)).toISOString();
    }

    write(state: SessionTransportHealthState, detail: SessionTransportHealthDetail): void {
        validateDetail(detail);
        const updatedAt = new Date().toISOString();
        if (state === 'connected' && this.lastState !== 'connected') this.connectedAt = updatedAt;
        if (state !== this.lastState &&
            (state === 'recovering' || state === 'ownership_conflict' || state === 'failed' || state === 'closed')) {
            this.disconnectedAt = updatedAt;
        }
        this.lastState = state;
        this.generation += 1;
        const base = {
            schema: SCHEMA,
            nativeSessionId: this.nativeSessionId,
            processId: process.pid,
            processStartedAt: this.processStartedAt,
            generation: this.generation,
            state,
            reconnectCount: detail.reconnectCount,
            queueMessages: detail.queueMessages,
            queueBytes: detail.queueBytes,
            reason: detail.reason === null ? null : truncateUtf8(detail.reason, MAX_REASON_BYTES),
            connectedAt: this.connectedAt,
            disconnectedAt: this.disconnectedAt,
            updatedAt,
        };
        const record = { ...base, recordDigest: digest(base) };
        const serialized = `${deterministicStringify(record)}\n`;
        if (Buffer.byteLength(serialized, 'utf8') > MAX_RECEIPT_BYTES) throw new Error('Happy transport health receipt exceeds budget');
        const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
        let descriptor: number | null = null;
        try {
            descriptor = openSync(temporary, 'wx', 0o600);
            writeFileSync(descriptor, serialized, 'utf8');
            fsyncSync(descriptor);
            closeSync(descriptor);
            descriptor = null;
            renameSync(temporary, this.path);
            const directoryDescriptor = openSync(this.directory, constants.O_RDONLY);
            try { fsyncSync(directoryDescriptor); }
            finally { closeSync(directoryDescriptor); }
        } catch (error) {
            if (descriptor !== null) closeSync(descriptor);
            try { unlinkSync(temporary); } catch { /* already renamed or absent */ }
            throw error;
        }
    }
}

export function createSessionTransportHealthReporter(
    workspace: string,
    nativeSessionId: string,
): SessionTransportHealthReporter | null {
    if (typeof workspace !== 'string' || workspace.length === 0 ||
        typeof nativeSessionId !== 'string' || !SESSION_ID_RE.test(nativeSessionId)) return null;
    const virtualRoot = join(workspace, '.virtual-session');
    if (!existsSync(virtualRoot)) return null;
    const rootStat = lstatSync(virtualRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const realRoot = realpathSync(virtualRoot);
    const runtime = ensureDirectory(join(realRoot, 'runtime'));
    const providerHealth = ensureDirectory(join(runtime, 'provider-health'), true);
    const happy = ensureDirectory(join(providerHealth, 'happy'), true);
    return new SessionTransportHealthReporter(happy, nativeSessionId);
}

function ensureDirectory(path: string, privateDirectory = false): string {
    if (!existsSync(path)) mkdirSync(path, { recursive: false, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Happy transport health path is not a safe directory');
    if (privateDirectory && (stat.mode & 0o077) !== 0) chmodSync(path, 0o700);
    return realpathSync(path);
}

function validateDetail(detail: SessionTransportHealthDetail): void {
    if (!detail || !Number.isSafeInteger(detail.reconnectCount) || detail.reconnectCount < 0 ||
        !Number.isSafeInteger(detail.queueMessages) || detail.queueMessages < 0 ||
        !Number.isSafeInteger(detail.queueBytes) || detail.queueBytes < 0 ||
        (detail.reason !== null && typeof detail.reason !== 'string')) {
        throw new Error('Happy transport health detail is invalid');
    }
}

function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(deterministicStringify(value)).digest('hex')}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
    let result = '';
    for (const character of value) {
        if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
        result += character;
    }
    return result;
}
