import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';
import type { BangCommandContext } from './types';
import { findHtaskRoot, htaskCanonicalTitle, runHtask } from './htaskCommand';

export const REPLY_MONITOR_ALERT_DELAY_MS = 60_000;
export const REPLY_MONITOR_POLL_INTERVAL_MS = 2_000;
const REPLY_MONITOR_ALERT_MARKER = '⚠️';
const HTASK_CONTROL_CENTER_TITLE_MARKER = '❇️';
const HTASK_SAFE_REF = /^[A-Za-z0-9_.-]+$/;

export interface ReplyMonitorRuntimeOptions {
    idleMs?: number;
    pollMs?: number;
    isEnabled: () => boolean | Promise<boolean>;
    canonicalTitle: () => string | null | Promise<string | null>;
    pendingMessages?: () => TaskMessageRecord[] | Promise<TaskMessageRecord[]>;
    deliverMessage?: (messageId: string) => string | null | Promise<string | null>;
    currentTitle?: () => string | null;
    sendTitle: (title: string) => void;
    sendTaskMessage?: (message: string) => void;
    now?: () => number;
    debug?: (message: string, error?: unknown) => void;
}

export interface TaskMessageRecord {
    message_id: string;
    status: 'pending' | 'delivered' | 'acked' | 'dismissed' | string;
}

export class ReplyMonitorRuntime {
    private interval: ReturnType<typeof setInterval> | null = null;
    private disposed = false;
    private syncInFlight = false;
    private readonly deliveredReminderIds = new Set<string>();
    private lastActivityAt: number | null = null;
    private readonly idleMs: number;
    private readonly isEnabled: ReplyMonitorRuntimeOptions['isEnabled'];
    private readonly canonicalTitle: ReplyMonitorRuntimeOptions['canonicalTitle'];
    private readonly pendingMessages: NonNullable<ReplyMonitorRuntimeOptions['pendingMessages']>;
    private readonly deliverMessage: NonNullable<ReplyMonitorRuntimeOptions['deliverMessage']>;
    private readonly currentTitle: NonNullable<ReplyMonitorRuntimeOptions['currentTitle']>;
    private readonly sendTitle: ReplyMonitorRuntimeOptions['sendTitle'];
    private readonly sendTaskMessage: NonNullable<ReplyMonitorRuntimeOptions['sendTaskMessage']>;
    private readonly now: NonNullable<ReplyMonitorRuntimeOptions['now']>;
    private readonly debug: NonNullable<ReplyMonitorRuntimeOptions['debug']>;

    constructor(options: ReplyMonitorRuntimeOptions) {
        this.idleMs = options.idleMs ?? REPLY_MONITOR_ALERT_DELAY_MS;
        this.isEnabled = options.isEnabled;
        this.canonicalTitle = options.canonicalTitle;
        this.pendingMessages = options.pendingMessages ?? (async () => []);
        this.deliverMessage = options.deliverMessage ?? (async () => null);
        this.currentTitle = options.currentTitle ?? (() => null);
        this.sendTitle = options.sendTitle;
        this.sendTaskMessage = options.sendTaskMessage ?? (() => undefined);
        this.now = options.now ?? (() => Date.now());
        this.debug = options.debug ?? ((message, error) => logger.debug(message, error));
        const pollMs = options.pollMs ?? REPLY_MONITOR_POLL_INTERVAL_MS;
        this.interval = setInterval(() => {
            void this.syncTitle('poll');
        }, pollMs);
    }

    observeUserMessage(): void {
        this.markActivity('user-message');
    }

    observeReceiveActivity(reason = 'receive'): void {
        this.markActivity(reason);
    }

    observeAssistantReply(): void {
        this.observeReceiveActivity('assistant-reply');
    }

    stopMonitoring(reason = 'stop'): void {
        this.debug(`[reply-monitor] stop requested reason=${reason}`);
        this.lastActivityAt = null;
        void this.syncTitle(reason);
    }

    dispose(): void {
        this.disposed = true;
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    async syncTitle(reason = 'manual'): Promise<void> {
        if (this.disposed || this.syncInFlight) return;
        this.syncInFlight = true;
        try {
            await this.syncCanonicalTitle(reason);
            await this.syncTaskMessages(reason);
        } finally {
            this.syncInFlight = false;
        }
    }

    private markActivity(reason: string): void {
        this.lastActivityAt = this.now();
        this.debug(`[reply-monitor] activity reason=${reason} at=${this.lastActivityAt}`);
    }

    private async syncCanonicalTitle(reason: string): Promise<void> {
        try {
            const canonical = await this.canonicalTitle();
            if (!canonical) {
                this.debug(`[reply-monitor] title sync skipped missing-title reason=${reason}`);
                return;
            }

            const enabled = await this.isEnabled();
            const idle = enabled
                && this.lastActivityAt !== null
                && this.now() - this.lastActivityAt >= this.idleMs;
            const expected = idle && !titleHasAlert(canonical)
                ? titleWithAlert(canonical)
                : canonical;
            const current = this.currentTitle();
            if (current === expected) {
                this.debug(`[reply-monitor] title unchanged reason=${reason} idle=${idle}`);
                return;
            }
            this.sendTitle(expected);
            this.debug(`[reply-monitor] title sent reason=${reason} idle=${idle}`);
        } catch (error) {
            this.debug('[reply-monitor] title sync skipped', error);
        }
    }

    private async syncTaskMessages(reason: string): Promise<void> {
        try {
            const messages = await this.pendingMessages();
            for (const message of messages) {
                if (message.status === 'pending') {
                    const text = await this.deliverMessage(message.message_id);
                    if (text) {
                        this.deliveredReminderIds.add(message.message_id);
                        this.sendTaskMessage(text);
                        this.debug(`[reply-monitor] task message delivered reason=${reason} message=${message.message_id}`);
                    }
                    continue;
                }
                if (message.status === 'delivered' && !this.deliveredReminderIds.has(message.message_id)) {
                    this.deliveredReminderIds.add(message.message_id);
                    this.sendTaskMessage(`【任务消息待处理，不是用户原话；message_id=${message.message_id}】该消息已投递但尚未 ack/dismiss。`);
                    this.debug(`[reply-monitor] task message pending acknowledgement reason=${reason} message=${message.message_id}`);
                }
            }
        } catch (error) {
            this.debug('[reply-monitor] task message sync skipped', error);
        }
    }
}

function titleHasAlert(title: string): boolean {
    const tokens = title.trim().split(/\s+/);
    return tokens.includes(REPLY_MONITOR_ALERT_MARKER);
}

function titleWithAlert(canonical: string): string {
    if (canonical.startsWith(`${HTASK_CONTROL_CENTER_TITLE_MARKER} `)) {
        return `${HTASK_CONTROL_CENTER_TITLE_MARKER} ${REPLY_MONITOR_ALERT_MARKER} ${canonical.slice(`${HTASK_CONTROL_CENTER_TITLE_MARKER} `.length)}`;
    }
    return `${REPLY_MONITOR_ALERT_MARKER} ${canonical}`;
}

function readReplyMonitorBinding(root: string, happyId: string): { taskId: string; task: Record<string, unknown> } | null {
    if (!happyId || !HTASK_SAFE_REF.test(happyId)) return null;
    let cfg: unknown;
    try {
        cfg = JSON.parse(readFileSync(join(root, '.htask', 'cfg', `${happyId}.json`), 'utf8'));
    } catch (error) {
        logger.debug('[reply-monitor] cfg read skipped', error);
        return null;
    }
    const taskId = cfg && typeof cfg === 'object' ? (cfg as { task_id?: unknown }).task_id : null;
    if (typeof taskId !== 'string' || !HTASK_SAFE_REF.test(taskId)) return null;

    try {
        const parsed = JSON.parse(readFileSync(join(root, '.htask', 'task', `${taskId}.json`), 'utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        const task = (parsed as { task?: unknown }).task;
        return {
            taskId,
            task: task && typeof task === 'object' ? task as Record<string, unknown> : parsed as Record<string, unknown>,
        };
    } catch (error) {
        logger.debug('[reply-monitor] task read failed', error);
        return null;
    }
}

function readReplyMonitorTask(root: string, happyId: string): Record<string, unknown> | null {
    return readReplyMonitorBinding(root, happyId)?.task ?? null;
}

function parseTaskMessages(stdout: string): TaskMessageRecord[] {
    const parsed = JSON.parse(stdout) as { messages?: unknown };
    if (!Array.isArray(parsed.messages)) return [];
    return parsed.messages.filter((message): message is TaskMessageRecord => {
        if (!message || typeof message !== 'object') return false;
        const rec = message as { message_id?: unknown; status?: unknown };
        return typeof rec.message_id === 'string' && typeof rec.status === 'string';
    });
}

export function createHtaskReplyMonitorRuntime(
    session: ApiSessionClient,
    flavor: BangCommandContext['flavor'],
    idleMs = REPLY_MONITOR_ALERT_DELAY_MS,
    pollMs = REPLY_MONITOR_POLL_INTERVAL_MS,
): ReplyMonitorRuntime {
    const titleSender = (summary: string) => {
        session.sendClaudeSessionMessage({
            type: 'summary',
            summary,
            leafUuid: randomUUID(),
        } as never);
    };

    return new ReplyMonitorRuntime({
        idleMs,
        pollMs,
        isEnabled: async () => {
            const root = findHtaskRoot();
            if (!root) return false;
            const task = readReplyMonitorTask(root, session.sessionId);
            return task?.reply_monitor === true;
        },
        canonicalTitle: async () => {
            const root = findHtaskRoot();
            return root ? htaskCanonicalTitle(root, session.sessionId, flavor) : null;
        },
        pendingMessages: async () => {
            const root = findHtaskRoot();
            if (!root) return [];
            const binding = readReplyMonitorBinding(root, session.sessionId);
            if (!binding) return [];
            const result = await runHtask(root, ['message-list', '--task-id', binding.taskId]);
            if (result.code !== 0) {
                throw new Error(result.stderr || result.stdout || 'message-list failed');
            }
            return parseTaskMessages(result.stdout);
        },
        deliverMessage: async (messageId: string) => {
            const root = findHtaskRoot();
            if (!root) return null;
            const result = await runHtask(root, ['message-deliver', '--happy', session.sessionId, '--message-id', messageId]);
            if (result.code !== 0) {
                throw new Error(result.stderr || result.stdout || 'message-deliver failed');
            }
            const parsed = JSON.parse(result.stdout) as { inject_text?: unknown };
            return typeof parsed.inject_text === 'string' ? parsed.inject_text : null;
        },
        currentTitle: () => session.getSummaryText(),
        sendTitle: titleSender,
        sendTaskMessage: message => session.sendSessionEvent({ type: 'message', message }),
    });
}
