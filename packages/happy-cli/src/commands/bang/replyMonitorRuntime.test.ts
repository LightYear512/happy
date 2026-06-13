import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplyMonitorRuntime } from './replyMonitorRuntime';

function createMonitor(options?: {
    enabled?: () => boolean;
    canonical?: () => string | null;
    initialTitle?: string | null;
    now?: () => number;
}) {
    const titles: string[] = [];
    let current = options?.initialTitle ?? null;
    const monitor = new ReplyMonitorRuntime({
        idleMs: 60_000,
        pollMs: 10_000,
        isEnabled: options?.enabled ?? (() => true),
        canonicalTitle: options?.canonical ?? (() => '🔵 [0001-任务 0/1] 做事'),
        currentTitle: () => current,
        now: options?.now,
        sendTitle: title => {
            current = title;
            titles.push(title);
        },
    });
    return { monitor, titles, currentTitle: () => current };
}

describe('ReplyMonitorRuntime', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('syncs the canonical title on the low-frequency poll', async () => {
        vi.useFakeTimers();
        const { monitor, titles } = createMonitor();

        await vi.advanceTimersByTimeAsync(9_999);
        expect(titles).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        expect(titles).toEqual(['🔵 [0001-任务 0/1] 做事']);
        monitor.dispose();
    });

    it('alerts only after the idle timeout reaches a poll', async () => {
        vi.useFakeTimers();
        const { monitor, titles } = createMonitor();

        monitor.observeUserMessage();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(titles).toEqual(['🔵 [0001-任务 0/1] 做事']);

        await vi.advanceTimersByTimeAsync(49_999);
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
        await vi.advanceTimersByTimeAsync(45_000);
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
            canonical: () => '🔅 🔵 [0001-任务 0/1] 做事',
        });

        monitor.observeUserMessage();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(titles).toEqual([
            '🔅 🔵 [0001-任务 0/1] 做事',
            '⚠️ 🔅 🔵 [0001-任务 0/1] 做事',
        ]);

        monitor.observeReceiveActivity('text');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(titles).toEqual([
            '🔅 🔵 [0001-任务 0/1] 做事',
            '⚠️ 🔅 🔵 [0001-任务 0/1] 做事',
            '🔅 🔵 [0001-任务 0/1] 做事',
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
});
