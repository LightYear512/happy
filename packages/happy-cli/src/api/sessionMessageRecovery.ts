/** Exact selection and merge rules for messages missed during a live reconnect. */

export const RECENT_MESSAGE_WINDOW = 150;
export const MAX_RECOVERY_COLLECTION_BYTES = 32 * 1024 * 1024;
export const MAX_RECOVERY_RESPONSE_BYTES = 36 * 1024 * 1024;
const MAX_RECOVERY_BUFFER_ROWS = 512;
const MAX_ENCRYPTED_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_ID_BYTES = 128;
const MAX_DATE_MS = 8_640_000_000_000_000;

export interface SessionRecoveryAnchor {
    id: string | null;
    seq: number;
}

export interface SessionRecoveryRow {
    id: string;
    seq: number;
    localId: string | null;
    createdAt: number;
    content: { t: 'encrypted'; c: string };
}

export class SessionRecoveryError extends Error {
    readonly code = 'recovery_incomplete';

    constructor(reason: string) {
        super(`recovery_incomplete: ${reason}`);
        this.name = 'SessionRecoveryError';
    }
}

export function validateRecentMessageWindow(rawRows: unknown): SessionRecoveryRow[] {
    return validateAndOrderRows(rawRows, RECENT_MESSAGE_WINDOW);
}

export function selectRecoveryMessages(rawRows: unknown, anchor: SessionRecoveryAnchor): SessionRecoveryRow[] {
    const rows = validateRecentMessageWindow(rawRows);
    validateAnchor(anchor);
    if (anchor.id !== null) {
        const exact = rows.find((message) => message.id === anchor.id);
        if (!exact || exact.seq !== anchor.seq) {
            throw new SessionRecoveryError('recent message window does not contain the exact reconnect anchor');
        }
        return rows.filter((message) => message.seq > anchor.seq);
    }
    if (rows.length === RECENT_MESSAGE_WINDOW && rows[0].seq > anchor.seq) {
        throw new SessionRecoveryError('full recent message window cannot prove sequence-only continuity');
    }
    return rows.filter((message) => message.seq > anchor.seq);
}

export function mergeRecoveryMessages(
    queriedRows: SessionRecoveryRow[],
    bufferedRows: SessionRecoveryRow[],
): SessionRecoveryRow[] {
    return validateAndOrderRows([...queriedRows, ...bufferedRows], RECENT_MESSAGE_WINDOW + MAX_RECOVERY_BUFFER_ROWS);
}

function validateAndOrderRows(value: unknown, maxRows: number): SessionRecoveryRow[] {
    if (!Array.isArray(value) || value.length > maxRows) {
        throw new SessionRecoveryError('message collection is invalid or oversized');
    }
    const byId = new Map<string, SessionRecoveryRow>();
    const bySeq = new Map<number, string>();
    let collectionBytes = 0;
    for (const raw of value) {
        const row = validateRow(raw);
        const existing = byId.get(row.id);
        if (existing) {
            if (!sameRecoveryRow(existing, row)) throw new SessionRecoveryError('one message id has conflicting persisted identity');
            continue;
        }
        const seqOwner = bySeq.get(row.seq);
        if (seqOwner && seqOwner !== row.id) throw new SessionRecoveryError('one message sequence has conflicting ids');
        collectionBytes += recoveryRowBytes(row);
        if (collectionBytes > MAX_RECOVERY_COLLECTION_BYTES) {
            throw new SessionRecoveryError('message collection exceeds the recovery byte budget');
        }
        byId.set(row.id, row);
        bySeq.set(row.seq, row.id);
    }
    return [...byId.values()].sort((left, right) => left.seq - right.seq);
}

function validateRow(value: unknown): SessionRecoveryRow {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new SessionRecoveryError('message row is not an object');
    }
    const row = value as Record<string, unknown>;
    if (typeof row.id !== 'string' || row.id.length === 0 || Buffer.byteLength(row.id, 'utf8') > MAX_MESSAGE_ID_BYTES ||
        !Number.isSafeInteger(row.seq) || Number(row.seq) <= 0 ||
        !Number.isSafeInteger(row.createdAt) || Number(row.createdAt) <= 0 || Number(row.createdAt) > MAX_DATE_MS ||
        (row.localId !== undefined && row.localId !== null &&
            (typeof row.localId !== 'string' || !/^[^\u0000-\u001f]{1,256}$/u.test(row.localId))) ||
        !row.content || typeof row.content !== 'object' || Array.isArray(row.content)) {
        throw new SessionRecoveryError('message row identity is invalid');
    }
    const content = row.content as Record<string, unknown>;
    if (content.t !== 'encrypted' || typeof content.c !== 'string' || content.c.length === 0 ||
        Buffer.byteLength(content.c, 'utf8') > MAX_ENCRYPTED_MESSAGE_BYTES) {
        throw new SessionRecoveryError('message row content is invalid');
    }
    return {
        id: row.id,
        seq: Number(row.seq),
        localId: typeof row.localId === 'string' ? row.localId : null,
        createdAt: Number(row.createdAt),
        content: { t: 'encrypted', c: content.c },
    };
}

function validateAnchor(anchor: SessionRecoveryAnchor): void {
    if (!anchor || !Number.isSafeInteger(anchor.seq) || anchor.seq < 0 ||
        (anchor.id !== null && (typeof anchor.id !== 'string' || anchor.id.length === 0 ||
            Buffer.byteLength(anchor.id, 'utf8') > MAX_MESSAGE_ID_BYTES))) {
        throw new SessionRecoveryError('reconnect anchor is invalid');
    }
}

export function recoveryRowBytes(row: SessionRecoveryRow): number {
    return Buffer.byteLength(row.id, 'utf8') + Buffer.byteLength(row.localId ?? '', 'utf8')
        + Buffer.byteLength(row.content.c, 'utf8') + 32;
}

export function sameRecoveryRow(left: SessionRecoveryRow, right: SessionRecoveryRow): boolean {
    return left.id === right.id && left.seq === right.seq && left.localId === right.localId
        && left.createdAt === right.createdAt &&
        left.content.t === right.content.t && left.content.c === right.content.c;
}
