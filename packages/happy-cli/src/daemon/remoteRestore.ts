import { randomUUID } from 'node:crypto';
import type { SpawnSessionResult } from '../modules/common/registerCommonHandlers';
import { redactSensitive } from '../codex/utils/redactSecrets';

export const NO_NEW_RESTORE_INPUT = 'Automatic restore skipped: no new user input';
export const RESTORE_ALREADY_RUNNING = 'A Happy process exists but provider readiness is not confirmed';
const MAX_NOTICES = 16;

export interface RestoreNotice {
    id: string;
    inputSeq: number;
    message: string | null;
    encryptedRecord?: string;
}

/** Stored inside the existing restore authority, not a second session store. */
export interface RemoteRestoreState {
    lastAttemptedUserSeq?: number;
    restoreNotices?: RestoreNotice[];
}

export function validateRemoteRestoreState(value: RemoteRestoreState): void {
    if (value.lastAttemptedUserSeq !== undefined &&
        (!Number.isSafeInteger(value.lastAttemptedUserSeq) || value.lastAttemptedUserSeq <= 0)) {
        throw new Error('Invalid automatic restore input sequence');
    }
    if (value.restoreNotices !== undefined) {
        if (!Array.isArray(value.restoreNotices) || value.restoreNotices.length > MAX_NOTICES) {
            throw new Error('Invalid restore notification queue');
        }
        const ids = new Set<string>();
        for (const notice of value.restoreNotices) {
            if (!notice || Object.keys(notice).some(key => !['id', 'inputSeq', 'message', 'encryptedRecord'].includes(key))
                || typeof notice.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(notice.id)
                || ids.has(notice.id) || !Number.isSafeInteger(notice.inputSeq) || notice.inputSeq <= 0
                || notice.inputSeq > (value.lastAttemptedUserSeq ?? 0)
                || (notice.message !== null && (typeof notice.message !== 'string'
                    || !notice.message || Buffer.byteLength(notice.message) > 4096))
                || (notice.encryptedRecord !== undefined && (notice.message === null
                    || typeof notice.encryptedRecord !== 'string' || !notice.encryptedRecord
                    || Buffer.byteLength(notice.encryptedRecord) > 32_768))) {
                throw new Error('Invalid restore notification');
            }
            ids.add(notice.id);
        }
    }
}

export function restoreTransportNotice(source: string, code: string, message: string): string | null {
    if (source !== 'happy.restore' || code !== 'happy.restore.failed') return null;
    if (message === NO_NEW_RESTORE_INPUT) {
        return '未发现新的用户输入，未重复启动会话。需要重试时请发送新消息或手动恢复。';
    }
    if (message === RESTORE_ALREADY_RUNNING) {
        return '已有会话进程，尚未确认输入通道就绪；未重复启动，也未关闭现有进程。';
    }
    if (message === 'operation has timed out') {
        // This is the old Server request's timeout, NOT a local attempt result.
        return '恢复请求等待超时；这不代表本机恢复已失败。请等待带恢复编号的结果，或查询本机会话状态。';
    }
    return null;
}

/** One overall budget including lookup and persistence, below Server's 25s ACK. */
export async function withinRestoreNoticeBudget<T>(operation: (remaining: () => number) => Promise<T>,
    timeoutMs = 20_000): Promise<T> {
    const deadline = performance.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remaining = () => {
        const value = Math.floor(deadline - performance.now());
        if (value <= 0) throw new Error('Restore notification deadline exceeded');
        return value;
    };
    try {
        return await Promise.race([operation(remaining), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Restore notification deadline exceeded')), timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}

type Update = (sessionId: string, change: (state: RemoteRestoreState) => RemoteRestoreState) => Promise<RemoteRestoreState>;

/** Runs under the daemon's existing lifecycle queue. Delivery never owns readiness. */
export class RemoteRestoreDelivery {
    private readonly active = new Set<string>();
    private readonly pending = new Set<string>();
    private flushing = false;
    private flushRequested = false;

    constructor(private readonly update: Update,
        private readonly publish: (sessionId: string, notice: RestoreNotice) => Promise<void>,
        private readonly log: (error: unknown) => void) {}

    recover(sessionIds: Iterable<string>): void {
        for (const id of sessionIds) this.pending.add(id);
    }

    async run(sessionId: string, inputSeq: number, restore: () => Promise<SpawnSessionResult>): Promise<SpawnSessionResult> {
        const id = randomUUID();
        this.active.add(id);
        try {
            await this.update(sessionId, state => {
                if (!Number.isSafeInteger(inputSeq) || inputSeq <= (state.lastAttemptedUserSeq ?? 0)) {
                    throw new Error(NO_NEW_RESTORE_INPUT);
                }
                if ((state.restoreNotices?.length ?? 0) >= MAX_NOTICES) {
                    throw new Error('Restore notification backlog is full; use explicit local restore or retry after delivery');
                }
                return { ...state, lastAttemptedUserSeq: inputSeq,
                    restoreNotices: [...(state.restoreNotices ?? []), { id, inputSeq, message: null }] };
            });
            this.pending.add(sessionId);
            let result: SpawnSessionResult;
            try { result = await restore(); }
            catch (error) { result = { type: 'error', errorMessage: String(error) }; }
            const outcome = result.type === 'success' && result.sessionId === sessionId
                ? '已恢复，输入通道已就绪（不代表模型已回复）'
                : result.type === 'error' ? `失败：${redactSensitive(result.errorMessage).slice(0, 700)}`
                    : '未完成：恢复结果未确认';
            try {
                await this.update(sessionId, state => ({ ...state, restoreNotices: state.restoreNotices?.map(notice =>
                    notice.id === id ? { ...notice, message: `恢复 ${id}（输入序号 ${inputSeq}）：${outcome}` } : notice) }));
            } catch (error) {
                // The durable pending record survives. Never turn a usable
                // provider into a failure just because notification storage failed.
                this.log(error);
            }
            return result;
        } finally {
            this.active.delete(id);
        }
    }

    async flush(): Promise<void> {
        this.flushRequested = true;
        if (this.flushing) return;
        this.flushing = true;
        try {
            do {
                this.flushRequested = false;
                // One bounded send per session per sweep; a failing session cannot
                // monopolize delivery. Failed/unconfirmed sends retain the exact record.
                for (const sessionId of [...this.pending]) {
                    try {
                        const state = await this.update(sessionId, state => ({ ...state,
                            restoreNotices: state.restoreNotices?.map(notice => notice.message === null && !this.active.has(notice.id)
                                ? { ...notice, message: `恢复 ${notice.id}（输入序号 ${notice.inputSeq}）：最终结果未完整记录，仍未确认；请查询状态或手动恢复。` }
                                : notice) }));
                        const notice = state.restoreNotices?.find(item => item.message !== null);
                        if (!state.restoreNotices?.length) this.pending.delete(sessionId);
                        if (!notice) continue;
                        await this.publish(sessionId, notice);
                        await this.update(sessionId, current => ({ ...current,
                            restoreNotices: current.restoreNotices?.filter(item => item.id !== notice.id) }));
                    } catch (error) { this.log(error); }
                }
                // Coalesce triggers received during I/O without creating another
                // sender or waiting for the next heartbeat to see the new result.
            } while (this.flushRequested);
        } finally { this.flushing = false; }
    }
}
