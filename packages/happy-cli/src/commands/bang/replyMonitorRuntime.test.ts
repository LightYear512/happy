import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    REPLY_MONITOR_ALERT_DELAY_MS,
    REPLY_MONITOR_POLL_INTERVAL_MS,
    ReplyMonitorRuntime,
    readReplyMonitorBinding,
} from './replyMonitorRuntime';
import { buildHtaskPromptPayload, resolveHtaskHappyId } from './htaskCommand';

function createMonitor(options?: {
    enabled?: () => boolean;
    canonical?: () => string | null;
    messages?: () => Array<{ message_id: string; status: string }> | Promise<Array<{ message_id: string; status: string }>>;
    deliver?: (messageId: string) => string | null | Promise<string | null>;
    initialTitle?: string | null;
    now?: () => number;
    pollMs?: number;
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

describe('ReplyMonitorRuntime', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('syncs the canonical title on the low-frequency poll', async () => {
        vi.useFakeTimers();
        const { monitor, titles } = createMonitor();

        expect(REPLY_MONITOR_POLL_INTERVAL_MS).toBe(2_000);
        expect(REPLY_MONITOR_ALERT_DELAY_MS).toBe(60_000);

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
        const deliver = vi.fn((messageId: string) => `【任务消息，不是用户原话；message_id=${messageId}】hello`);
        const { monitor, taskMessages } = createMonitor({
            messages: () => [{ message_id: 'TM-1', status: 'pending' }],
            deliver,
        });

        await vi.advanceTimersByTimeAsync(2_000);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver).toHaveBeenCalledWith('TM-1');
        expect(taskMessages).toEqual(['【任务消息，不是用户原话；message_id=TM-1】hello']);
        monitor.dispose();
    });

    it('does not repeatedly inject delivered-but-unacked messages', async () => {
        vi.useFakeTimers();
        let status = 'pending';
        const deliver = vi.fn(() => {
            status = 'delivered';
            return '【任务消息，不是用户原话；message_id=TM-1】hello';
        });
        const { monitor, taskMessages } = createMonitor({
            messages: () => [{ message_id: 'TM-1', status }],
            deliver,
        });

        await vi.advanceTimersByTimeAsync(2_000);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(taskMessages).toEqual(['【任务消息，不是用户原话；message_id=TM-1】hello']);
        monitor.dispose();
    });

    it('sends one lightweight reminder for already delivered unacked messages', async () => {
        vi.useFakeTimers();
        const { monitor, taskMessages } = createMonitor({
            messages: () => [{ message_id: 'TM-1', status: 'delivered' }],
        });

        await vi.advanceTimersByTimeAsync(2_000);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(taskMessages).toEqual(['【任务消息待处理，不是用户原话；message_id=TM-1】该消息已投递但尚未 ack/dismiss。']);
        monitor.dispose();
    });

    it('stops notifying after ack clears the pending message list', async () => {
        vi.useFakeTimers();
        let messages: Array<{ message_id: string; status: string }> = [
            { message_id: 'TM-1', status: 'pending' },
        ];
        const deliver = vi.fn(() => {
            messages = [];
            return '【任务消息，不是用户原话；message_id=TM-1】hello';
        });
        const { monitor, taskMessages } = createMonitor({
            messages: () => messages,
            deliver,
        });

        await vi.advanceTimersByTimeAsync(2_000);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(taskMessages).toEqual(['【任务消息，不是用户原话；message_id=TM-1】hello']);
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
