import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerKillSessionHandler } from './registerKillSessionHandler';

describe('registerKillSessionHandler', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns the RPC acknowledgement before starting process cleanup', async () => {
        vi.useFakeTimers();
        let handler: (() => Promise<unknown>) | undefined;
        const manager = {
            registerHandler: vi.fn((_method: string, registered: () => Promise<unknown>) => {
                handler = registered;
            }),
        };
        const killThisHappy = vi.fn(async () => {});

        registerKillSessionHandler(manager as never, killThisHappy);

        await expect(handler?.()).resolves.toEqual({
            success: true,
            message: 'Killing happy-cli process',
        });
        expect(killThisHappy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(99);
        expect(killThisHappy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(killThisHappy).toHaveBeenCalledTimes(1);
    });
});
