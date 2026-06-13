import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';
import type { BangCommandContext } from './types';
import { renderOptionsBlock, type BangOptionSuggestion } from './types';
import { findHtaskRoot, htaskCanonicalTitle, runHtask } from './htaskCommand';

export const REPLY_MONITOR_ALERT_DELAY_MS = 60_000;
export const REPLY_MONITOR_POLL_INTERVAL_MS = 2_000;
export const TASK_MESSAGE_REMINDER_INTERVAL_MS = 60_000;
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
    taskMessageReminderMs?: number;
    currentTitle?: () => string | null;
    sendTitle: (title: string) => void;
    sendTaskMessage?: (message: string) => void;
    now?: () => number;
    debug?: (message: string, error?: unknown) => void;
}

export interface TaskMessageRecord {
    message_id: string;
    status: 'pending' | 'delivered' | 'acked' | 'dismissed' | string;
    from_task_id?: string;
    to_task_id?: string;
    kind?: string;
    body?: string;
    ref?: string;
    created_at?: string;
    updated_at?: string;
}

export interface ReplyMonitorBinding {
    happyId: string;
    taskId: string;
    task: Record<string, unknown>;
}

export class ReplyMonitorRuntime {
    private interval: ReturnType<typeof setInterval> | null = null;
    private disposed = false;
    private syncInFlight = false;
    private readonly taskMessageReminderSentAt = new Map<string, number>();
    private lastActivityAt: number | null = null;
    private readonly idleMs: number;
    private readonly taskMessageReminderMs: number;
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
        this.taskMessageReminderMs = options.taskMessageReminderMs ?? TASK_MESSAGE_REMINDER_INTERVAL_MS;
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
            const visibleIds = new Set(messages.map(message => message.message_id));
            for (const messageId of this.taskMessageReminderSentAt.keys()) {
                if (!visibleIds.has(messageId)) {
                    this.taskMessageReminderSentAt.delete(messageId);
                }
            }
            for (const message of messages) {
                if (message.status === 'pending') {
                    const text = await this.deliverMessage(message.message_id);
                    if (text !== null) {
                        this.recordTaskMessageReminder(message.message_id);
                        this.sendTaskMessage(formatTaskMessageNotification(message));
                        this.debug(`[reply-monitor] task message delivered reason=${reason} message=${message.message_id}`);
                    }
                    continue;
                }
                if (message.status === 'delivered' && this.shouldSendTaskMessageReminder(message.message_id)) {
                    this.recordTaskMessageReminder(message.message_id);
                    this.sendTaskMessage(formatTaskMessageNotification(message));
                    this.debug(`[reply-monitor] task message pending acknowledgement reason=${reason} message=${message.message_id}`);
                }
            }
        } catch (error) {
            this.debug('[reply-monitor] task message sync skipped', error);
        }
    }

    private shouldSendTaskMessageReminder(messageId: string): boolean {
        const lastSentAt = this.taskMessageReminderSentAt.get(messageId);
        return lastSentAt === undefined || this.now() - lastSentAt >= this.taskMessageReminderMs;
    }

    private recordTaskMessageReminder(messageId: string): void {
        this.taskMessageReminderSentAt.set(messageId, this.now());
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

function isSafeHtaskRef(value: unknown): value is string {
    return typeof value === 'string' && HTASK_SAFE_REF.test(value);
}

function previewTaskMessageBody(body: unknown): string {
    const text = typeof body === 'string'
        ? body.replace(/\s+/g, ' ').trim()
        : '';
    if (!text) return '无正文';
    const chars = Array.from(text);
    if (chars.length <= 400) return text;
    return `${chars.slice(0, 200).join('')} … ${chars.slice(-200).join('')}`;
}

function formatTaskMessageTime(createdAt: unknown): string {
    if (typeof createdAt !== 'string' || !createdAt.trim()) return '时间未知';
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return createdAt.trim();
    const pad = (value: number) => value.toString().padStart(2, '0');
    return [
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    ].join(' ');
}

function taskMessageActionOptions(message: TaskMessageRecord): BangOptionSuggestion[] {
    const source = message.from_task_id || '外部';
    const sentAt = formatTaskMessageTime(message.created_at);
    const preview = previewTaskMessageBody(message.body);
    return [
        {
            label: `任务消息｜来源 ${source}｜发送 ${sentAt}｜${preview}`,
            disabled: true,
        },
        {
            label: '已处理，确认',
            value: `@task-ack ${message.message_id}`,
        },
        {
            label: '重复/不处理，忽略',
            value: `@task-dismiss ${message.message_id}`,
        },
    ];
}

export function formatTaskMessageNotification(message: TaskMessageRecord): string {
    return renderOptionsBlock(taskMessageActionOptions(message));
}

function readJsonObject(path: string, debugLabel: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch (error) {
        logger.debug(`[reply-monitor] ${debugLabel} read skipped`, error);
        return null;
    }
}

function readBindingFromHtaskHappy(root: string, happyId: string, expectedTaskId = ''): ReplyMonitorBinding | null {
    if (!isSafeHtaskRef(happyId)) return null;
    const cfg = readJsonObject(join(root, '.htask', 'cfg', `${happyId}.json`), `cfg ${happyId}`);
    const taskId = cfg?.task_id;
    if (!isSafeHtaskRef(taskId)) return null;
    if (expectedTaskId && taskId !== expectedTaskId) return null;
    const cfgLease = cfg.writer_lease;
    const lease = readJsonObject(join(root, '.htask', 'lease', 'task', `${taskId}.json`), `lease ${taskId}`);
    if (!cfgLease || typeof cfgLease !== 'object' || Array.isArray(cfgLease) || !lease) return null;
    const cfgLeaseRec = cfgLease as { token?: unknown; epoch?: unknown };
    if (lease.happy_id !== happyId || lease.task_id !== taskId) return null;
    if (!cfgLeaseRec.token || lease.token !== cfgLeaseRec.token) return null;
    if (Number(lease.epoch || 0) !== Number(cfgLeaseRec.epoch || 0)) return null;

    const parsed = readJsonObject(join(root, '.htask', 'task', `${taskId}.json`), `task ${taskId}`);
    if (!parsed) return null;
    const task = parsed.task;
    return {
        happyId,
        taskId,
        task: task && typeof task === 'object' && !Array.isArray(task)
            ? task as Record<string, unknown>
            : parsed,
    };
}

function readStableHappyFromSessionConfig(root: string, sessionId: string): { happyId: string; taskId: string } | null {
    if (!isSafeHtaskRef(sessionId)) return null;
    const config = readJsonObject(join(root, '.happy', 'session-config', `${sessionId}.json`), `session-config ${sessionId}`);
    const skills = config?.skills;
    const htask = skills && typeof skills === 'object' && !Array.isArray(skills)
        ? (skills as { htask?: unknown }).htask
        : null;
    if (!htask || typeof htask !== 'object' || Array.isArray(htask)) return null;
    const rec = htask as { bound?: unknown; stable_happy?: unknown; happy_id?: unknown; task_id?: unknown };
    if (rec.bound !== true) return null;
    const happyId = isSafeHtaskRef(rec.stable_happy) ? rec.stable_happy : rec.happy_id;
    const taskId = rec.task_id;
    if (!isSafeHtaskRef(happyId) || !isSafeHtaskRef(taskId)) return null;
    return { happyId, taskId };
}

function hasBoundHtaskSessionConfig(root: string, sessionId: string): boolean {
    if (!isSafeHtaskRef(sessionId)) return false;
    const config = readJsonObject(join(root, '.happy', 'session-config', `${sessionId}.json`), `session-config ${sessionId}`);
    const skills = config?.skills;
    const htask = skills && typeof skills === 'object' && !Array.isArray(skills)
        ? (skills as { htask?: unknown }).htask
        : null;
    return !!htask && typeof htask === 'object' && !Array.isArray(htask)
        && (htask as { bound?: unknown }).bound === true;
}

export function readReplyMonitorBinding(root: string, sessionId: string): ReplyMonitorBinding | null {
    const projected = readStableHappyFromSessionConfig(root, sessionId);
    if (projected) return readBindingFromHtaskHappy(root, projected.happyId, projected.taskId);
    if (hasBoundHtaskSessionConfig(root, sessionId)) return null;
    return readBindingFromHtaskHappy(root, sessionId);
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
        return isSafeHtaskRef(rec.message_id) && typeof rec.status === 'string';
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
            if (!root) return null;
            const binding = readReplyMonitorBinding(root, session.sessionId);
            return binding ? htaskCanonicalTitle(root, binding.happyId, flavor) : null;
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
            const binding = readReplyMonitorBinding(root, session.sessionId);
            if (!binding) return null;
            const result = await runHtask(root, ['message-deliver', '--happy', binding.happyId, '--message-id', messageId]);
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
