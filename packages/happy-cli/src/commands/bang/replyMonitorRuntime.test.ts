import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    REPLY_MONITOR_ALERT_DELAY_MS,
    REPLY_MONITOR_POLL_INTERVAL_MS,
    ReplyMonitorRuntime,
    TASK_MESSAGE_REMINDER_INTERVAL_MS,
    formatTaskMessagePlainNotification,
    readReplyMonitorBinding,
    sendTaskMessageToSession,
    type TaskMessageRecord,
} from './replyMonitorRuntime';
import { buildHtaskPromptPayload, resolveHtaskHappyId } from './htaskCommand';

function createMonitor(options?: {
    enabled?: () => boolean;
    canonical?: () => string | null;
    messages?: () => TaskMessageRecord[] | Promise<TaskMessageRecord[]>;
    deliver?: (messageId: string) => string | null | Promise<string | null>;
    initialTitle?: string | null;
    now?: () => number;
    pollMs?: number;
    taskMessageReminderMs?: number;
}) {
    const titles: string[] = [];
    const taskMessages: string[] = [];
    let current = options?.initialTitle ?? null;
    const monitor = new ReplyMonitorRuntime({
        idleMs: REPLY_MONITOR_ALERT_DELAY_MS,
        pollMs: options?.pollMs,
        isEnabled: options?.enabled ?? (() => true),
        canonicalTitle: options?.canonical ?? (() => '🔵 [0001-任务 0/1] 做事'),
        pendingMessages: options?.messages,
        deliverMessage: options?.deliver,
        taskMessageReminderMs: options?.taskMessageReminderMs,
        currentTitle: () => current,
        now: options?.now,
        sendTitle: title => {
            current = title;
            titles.push(title);
        },
        sendTaskMessage: message => {
            taskMessages.push(message);
        },
    });
    return { monitor, titles, taskMessages, currentTitle: () => current };
}

function taskMessageOptions(messageId = 'TM-1'): string {
    return [
        '<options>',
        `<option value="@task-ack ${messageId}">已处理，确认</option>`,
        `<option value="@task-dismiss ${messageId}">重复/不处理，忽略</option>`,
        '</options>',
    ].join('\n');
}

describe('ReplyMonitorRuntime', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('syncs the canonical title on the low-frequency poll', async () => {
        vi.useFakeTimers();
        const { monitor, titles } = createMonitor();

        expect(REPLY_MONITOR_POLL_INTERVAL_MS).toBe(2_000);
        expect(REPLY_MONITOR_ALERT_DELAY_MS).toBe(60_000);
        expect(TASK_MESSAGE_REMINDER_INTERVAL_MS).toBe(60_000);

        await vi.advanceTimersByTimeAsync(1_999);
        expect(titles).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        expect(titles).toEqual(['🔵 [0001-任务 0/1] 做事']);
        monitor.dispose();
    });

    it('alerts only after the idle timeout reaches a poll', async () => {
        vi.useFakeTimers();
        const { monitor, titles } = createMonitor();

        monitor.observeUserMessage();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(titles).toEqual(['🔵 [0001-任务 0/1] 做事']);

        await vi.advanceTimersByTimeAsync(57_999);
        expect(titles).toEqual(['🔵 [0001-任务 0/1] 做事']);

        await vi.advanceTimersByTimeAsync(1);
        expect(titles).toEqual([
            '🔵 [0001-任务 0/1] 做事',
            '⚠️ 🔵 [0001-任务 0/1] 做事',
        ]);
        monitor.dispose();
    });

    it('does not alert when the current task switch is disabled at poll time', async () => {
        vi.useFakeTimers();
        let enabled = true;
        const { monitor, titles } = createMonitor({ enabled: () => enabled });

        monitor.observeUserMessage();
        enabled = false;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(titles).toEqual(['🔵 [0001-任务 0/1] 做事']);
        monitor.dispose();
    });

    it('postpones the alert when output is still arriving', async () => {
        vi.useFakeTimers();
        const { monitor, titles } = createMonitor();

        monitor.observeUserMessage();
        await vi.advanceTimersByTimeAsync(44_000);
        monitor.observeReceiveActivity('text');
        await vi.advanceTimersByTimeAsync(59_999);
        expect(titles).toEqual(['🔵 [0001-任务 0/1] 做事']);

        await vi.advanceTimersByTimeAsync(1);
        expect(titles).toEqual([
            '🔵 [0001-任务 0/1] 做事',
            '⚠️ 🔵 [0001-任务 0/1] 做事',
        ]);
        monitor.dispose();
    });

    it('clears the alert on the next poll after new activity', async () => {
        vi.useFakeTimers();
        const { monitor, titles } = createMonitor({
            canonical: () => '❇️ 🔅 🔵 [0001-任务 0/1] 做事',
        });

        monitor.observeUserMessage();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(titles).toEqual([
            '❇️ 🔅 🔵 [0001-任务 0/1] 做事',
            '❇️ ⚠️ 🔅 🔵 [0001-任务 0/1] 做事',
        ]);

        monitor.observeReceiveActivity('text');
        await vi.advanceTimersByTimeAsync(2_000);
        expect(titles).toEqual([
            '❇️ 🔅 🔵 [0001-任务 0/1] 做事',
            '❇️ ⚠️ 🔅 🔵 [0001-任务 0/1] 做事',
            '❇️ 🔅 🔵 [0001-任务 0/1] 做事',
        ]);
        monitor.dispose();
    });

    it('stopMonitoring prevents later idle alerts', async () => {
        vi.useFakeTimers();
        const { monitor, titles } = createMonitor();

        monitor.observeUserMessage();
        await vi.advanceTimersByTimeAsync(45_000);
        monitor.observeReceiveActivity('text');
        monitor.stopMonitoring('kill');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(titles).toEqual(['🔵 [0001-任务 0/1] 做事']);
        monitor.dispose();
    });

    it('delivers one pending task message on the scanner poll', async () => {
        vi.useFakeTimers();
        const deliver = vi.fn(() => 'ignored htask inject text');
        const { monitor, taskMessages } = createMonitor({
            messages: () => [{
                message_id: 'TM-1',
                status: 'pending',
                from_task_id: 'HT-0282',
                created_at: '2026-06-13T15:46:03',
                body: 'hello',
            }],
            deliver,
        });

        await vi.advanceTimersByTimeAsync(2_000);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver).toHaveBeenCalledWith('TM-1');
        expect(taskMessages).toEqual([taskMessageOptions()]);
        expect(taskMessages[0]).not.toContain('message_id=');
        monitor.dispose();
    });

    it('throttles delivered-but-unacked task message reminders', async () => {
        vi.useFakeTimers();
        let status = 'pending';
        const deliver = vi.fn(() => {
            status = 'delivered';
            return 'ignored htask inject text';
        });
        const { monitor, taskMessages } = createMonitor({
            taskMessageReminderMs: 10_000,
            messages: () => [{
                message_id: 'TM-1',
                status,
                from_task_id: 'HT-0282',
                created_at: '2026-06-13T15:46:03',
                body: 'hello',
            }],
            deliver,
        });

        await vi.advanceTimersByTimeAsync(2_000);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(taskMessages).toEqual([taskMessageOptions()]);
        await vi.advanceTimersByTimeAsync(7_999);
        expect(taskMessages).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(taskMessages).toEqual([taskMessageOptions(), taskMessageOptions()]);
        monitor.dispose();
    });

    it('repeats lightweight reminders for already delivered unacked messages until ack or dismiss', async () => {
        vi.useFakeTimers();
        const { monitor, taskMessages } = createMonitor({
            taskMessageReminderMs: 10_000,
            messages: () => [{
                message_id: 'TM-1',
                status: 'delivered',
                from_task_id: 'HT-0282',
                created_at: '2026-06-13T15:46:03',
                body: 'hello',
            }],
        });

        await vi.advanceTimersByTimeAsync(2_000);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(taskMessages).toEqual([taskMessageOptions()]);
        expect(taskMessages[0]).not.toContain('message_id=');
        await vi.advanceTimersByTimeAsync(7_999);
        expect(taskMessages).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(taskMessages).toEqual([taskMessageOptions(), taskMessageOptions()]);
        monitor.dispose();
    });

    it('truncates long task message bodies to the first and last 200 characters', () => {
        const head = 'A'.repeat(205);
        const middle = 'MIDDLE-SHOULD-BE-HIDDEN';
        const tail = 'B'.repeat(205);
        const fallback = formatTaskMessagePlainNotification({
            message_id: 'TM-1',
            status: 'delivered',
            from_task_id: 'HT-0282',
            created_at: '2026-06-13T15:46:03',
            body: `${head}${middle}${tail}`,
        });

        expect(fallback).toContain(`${'A'.repeat(200)} … ${'B'.repeat(200)}`);
        expect(fallback).not.toContain(middle);
    });

    it('formats the visible task message fallback without option XML or message ids', () => {
        const text = formatTaskMessagePlainNotification({
            message_id: 'TM-1',
            status: 'delivered',
            from_task_id: 'HT-0282',
            created_at: '2026-06-13T15:46:03',
            body: 'hello',
        });

        expect(text).toContain('任务消息｜来源 HT-0282｜发送 2026-06-13 15:46');
        expect(text).toContain('hello');
        expect(text).not.toContain('<options>');
        expect(text).not.toContain('<option');
        expect(text).not.toContain('TM-1');
        expect(text).not.toContain('操作按钮');
    });

    it('passes a plain visible fallback alongside structured clickable options', async () => {
        vi.useFakeTimers();
        const calls: Array<{ markdown: string; fallback?: string; options?: unknown[] }> = [];
        const monitor = new ReplyMonitorRuntime({
            idleMs: REPLY_MONITOR_ALERT_DELAY_MS,
            pollMs: 2_000,
            isEnabled: () => true,
            canonicalTitle: () => '🔵 [0001-任务 0/1] 做事',
            pendingMessages: () => [{
                message_id: 'TM-1',
                status: 'delivered',
                from_task_id: 'HT-0282',
                created_at: '2026-06-13T15:46:03',
                body: 'hello',
            }],
            currentTitle: () => null,
            sendTitle: () => undefined,
            sendTaskMessage: (markdown, fallback, options) => calls.push({ markdown, fallback, options }),
        });

        await vi.advanceTimersByTimeAsync(2_000);
        expect(calls).toHaveLength(1);
        expect(calls[0].markdown).toContain('<options>');
        expect(calls[0].fallback).toContain('任务消息｜来源 HT-0282');
        expect(calls[0].fallback).not.toContain('<options>');
        expect(calls[0].fallback).not.toContain('TM-1');
        expect(calls[0].options).toEqual([
            expect.objectContaining({ label: expect.stringContaining('任务消息｜来源 HT-0282'), disabled: true }),
            expect.objectContaining({ label: '已处理，确认', value: '@task-ack TM-1' }),
            expect.objectContaining({ label: '重复/不处理，忽略', value: '@task-dismiss TM-1' }),
        ]);
        monitor.dispose();
    });

    it('sends task message actions as structured event options instead of Codex markdown text', () => {
        const events: unknown[] = [];
        const codexMessages: unknown[] = [];
        const session = {
            sendSessionEvent: (event: unknown) => events.push(event),
            sendCodexMessage: (message: unknown) => codexMessages.push(message),
        };

        sendTaskMessageToSession(
            session,
            taskMessageOptions(),
            'plain fallback',
            [
                { label: '任务消息｜来源 HT-0282｜发送 2026-06-13 15:46｜hello', disabled: true },
                { label: '已处理，确认', value: '@task-ack TM-1' },
                { label: '重复/不处理，忽略', value: '@task-dismiss TM-1' },
            ],
        );

        expect(codexMessages).toEqual([]);
        expect(events).toEqual([
            {
                type: 'options',
                options: [
                    { label: '任务消息｜来源 HT-0282｜发送 2026-06-13 15:46｜hello', disabled: true },
                    { label: '已处理，确认', value: '@task-ack TM-1' },
                    { label: '重复/不处理，忽略', value: '@task-dismiss TM-1' },
                ],
            },
        ]);
    });

    it('stops notifying after ack clears the pending message list', async () => {
        vi.useFakeTimers();
        let messages: TaskMessageRecord[] = [
            {
                message_id: 'TM-1',
                status: 'pending',
                from_task_id: 'HT-0282',
                created_at: '2026-06-13T15:46:03',
                body: 'hello',
            },
        ];
        const deliver = vi.fn(() => {
            messages = [];
            return 'ignored htask inject text';
        });
        const { monitor, taskMessages } = createMonitor({
            messages: () => messages,
            deliver,
        });

        await vi.advanceTimersByTimeAsync(2_000);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(taskMessages).toEqual([taskMessageOptions()]);
        monitor.dispose();
    });

    it('keeps title sync working when the task inbox read fails', async () => {
        vi.useFakeTimers();
        const { monitor, titles, taskMessages } = createMonitor({
            messages: () => {
                throw new Error('corrupt inbox');
            },
        });

        await vi.advanceTimersByTimeAsync(2_000);
        expect(titles).toEqual(['🔵 [0001-任务 0/1] 做事']);
        expect(taskMessages).toEqual([]);
        monitor.dispose();
    });

    it('resolves native session ids to stable htask happy ids through session-config', () => {
        const root = mkdtempSync(join(tmpdir(), 'reply-monitor-binding-'));
        try {
            mkdirSync(join(root, '.happy', 'session-config'), { recursive: true });
            mkdirSync(join(root, '.htask', 'cfg'), { recursive: true });
            mkdirSync(join(root, '.htask', 'lease', 'task'), { recursive: true });
            mkdirSync(join(root, '.htask', 'task'), { recursive: true });
            writeFileSync(join(root, '.happy', 'session-config', 'NATIVE-1.json'), JSON.stringify({
                version: 1,
                skills: {
                    htask: {
                        bound: true,
                        happy_id: 'STABLE-1',
                        stable_happy: 'STABLE-1',
                        task_id: 'HT-0001',
                    },
                },
            }));
            writeFileSync(join(root, '.htask', 'cfg', 'STABLE-1.json'), JSON.stringify({
                happy_id: 'STABLE-1',
                task_id: 'HT-0001',
                writer_lease: {
                    token: 'stable-token',
                    epoch: 1,
                },
            }));
            writeFileSync(join(root, '.htask', 'cfg', 'NATIVE-1.json'), JSON.stringify({
                happy_id: 'NATIVE-1',
                task_id: 'HT-0001',
                writer_lease: {
                    token: 'stale-token',
                    epoch: 1,
                },
            }));
            writeFileSync(join(root, '.htask', 'lease', 'task', 'HT-0001.json'), JSON.stringify({
                happy_id: 'STABLE-1',
                task_id: 'HT-0001',
                token: 'stable-token',
                epoch: 1,
            }));
            writeFileSync(join(root, '.htask', 'task', 'HT-0001.json'), JSON.stringify({
                task_id: 'HT-0001',
                title: '目标任务',
                reply_monitor: true,
            }));

            const binding = readReplyMonitorBinding(root, 'NATIVE-1');
            expect(binding?.happyId).toBe('STABLE-1');
            expect(binding?.taskId).toBe('HT-0001');
            expect(binding?.task.reply_monitor).toBe(true);
            expect(resolveHtaskHappyId(root, 'NATIVE-1')).toBe('STABLE-1');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects direct htask cfg fallback unless its writer lease snapshot is current', () => {
        const root = mkdtempSync(join(tmpdir(), 'reply-monitor-direct-binding-'));
        try {
            mkdirSync(join(root, '.htask', 'cfg'), { recursive: true });
            mkdirSync(join(root, '.htask', 'lease', 'task'), { recursive: true });
            mkdirSync(join(root, '.htask', 'task'), { recursive: true });
            writeFileSync(join(root, '.htask', 'task', 'HT-0001.json'), JSON.stringify({
                task_id: 'HT-0001',
                title: '旧任务',
                reply_monitor: true,
            }));
            writeFileSync(join(root, '.htask', 'cfg', 'NATIVE-OLD.json'), JSON.stringify({
                happy_id: 'NATIVE-OLD',
                task_id: 'HT-0001',
                writer_lease: { token: 'old-token', epoch: 1 },
            }));
            writeFileSync(join(root, '.htask', 'cfg', 'NATIVE-CURRENT.json'), JSON.stringify({
                happy_id: 'NATIVE-CURRENT',
                task_id: 'HT-0001',
                writer_lease: { token: 'current-token', epoch: 2 },
            }));
            writeFileSync(join(root, '.htask', 'lease', 'task', 'HT-0001.json'), JSON.stringify({
                happy_id: 'NATIVE-CURRENT',
                task_id: 'HT-0001',
                token: 'current-token',
                epoch: 2,
            }));

            expect(readReplyMonitorBinding(root, 'NATIVE-OLD')).toBeNull();
            expect(resolveHtaskHappyId(root, 'NATIVE-OLD')).toBe('');
            expect(readReplyMonitorBinding(root, 'NATIVE-CURRENT')?.happyId).toBe('NATIVE-CURRENT');
            expect(resolveHtaskHappyId(root, 'NATIVE-CURRENT')).toBe('NATIVE-CURRENT');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('omits native proof only for an already-validated direct current binding payload', () => {
        expect(JSON.parse(buildHtaskPromptPayload('NATIVE-1', 'STABLE-1', '@reply-monitor'))).toEqual({
            session_id: 'STABLE-1',
            native_session_id: 'NATIVE-1',
            prompt: '@reply-monitor',
        });
        expect(JSON.parse(buildHtaskPromptPayload('NATIVE-CURRENT', 'NATIVE-CURRENT', '@reply-monitor'))).toEqual({
            session_id: 'NATIVE-CURRENT',
            prompt: '@reply-monitor',
        });
        expect(JSON.parse(buildHtaskPromptPayload('NATIVE-OLD', '', '@reply-monitor'))).toEqual({
            session_id: 'NATIVE-OLD',
            native_session_id: 'NATIVE-OLD',
            prompt: '@reply-monitor',
        });
    });
});
