import { describe, expect, it, vi } from 'vitest';
import { completeProviderInputReady } from './completeProviderInputReady';

function createSession(overrides: Record<string, unknown> = {}) {
    return {
        sessionId: 'happy-1',
        onUserMessage: vi.fn(),
        updateMetadata: vi.fn().mockResolvedValue(undefined),
        enableDaemonSessionTracking: vi.fn(),
        ...overrides,
    } as any;
}

describe('completeProviderInputReady', () => {
    it('installs the consumer only after the pending restore window is merged', async () => {
        let release = () => {};
        const pendingWindow = new Promise<void>((resolve) => { release = resolve; });
        const session = createSession();
        const onUserMessage = vi.fn();
        const completion = completeProviderInputReady({
            session,
            expectedHappySessionId: 'happy-1',
            pendingWindow,
            onUserMessage,
        });

        await Promise.resolve();
        expect(session.onUserMessage).not.toHaveBeenCalled();
        expect(session.enableDaemonSessionTracking).not.toHaveBeenCalled();
        release();
        await completion;
        expect(session.onUserMessage).toHaveBeenCalledWith(onUserMessage);
        expect(session.enableDaemonSessionTracking).toHaveBeenCalledWith(undefined);
    });

    it('does not start deferred pending recovery before final provider readiness', async () => {
        const order: string[] = [];
        const session = createSession({
            onUserMessage: vi.fn(() => order.push('consumer')),
        });
        const deferred = vi.fn(async () => { order.push('pending'); });

        expect(deferred).not.toHaveBeenCalled();
        await completeProviderInputReady({
            session,
            expectedHappySessionId: 'happy-1',
            pendingWindow: deferred,
            onUserMessage: vi.fn(),
        });

        expect(order).toEqual(['pending', 'consumer']);
    });

    it('rejects Happy or provider identity drift before installing the consumer', async () => {
        const session = createSession();
        const onUserMessage = vi.fn();
        await expect(completeProviderInputReady({
            session,
            expectedHappySessionId: 'other',
            onUserMessage,
        })).rejects.toThrow('Happy session identity changed');
        await expect(completeProviderInputReady({
            session,
            expectedHappySessionId: 'happy-1',
            providerSessionId: 'provider-2',
            expectedProviderSessionId: 'provider-1',
            onUserMessage,
        })).rejects.toThrow('Provider session identity changed');
        expect(session.onUserMessage).not.toHaveBeenCalled();
    });

    it('installs the fresh-session consumer before metadata and daemon bookkeeping', async () => {
        const order: string[] = [];
        const session = createSession({
            onUserMessage: vi.fn(() => order.push('consumer')),
            updateMetadata: vi.fn(async (handler) => {
                expect(handler({ flavor: 'codex' })).toMatchObject({ claudeSessionId: 'provider-1' });
                order.push('metadata');
            }),
            enableDaemonSessionTracking: vi.fn(() => order.push('daemon')),
        });

        await completeProviderInputReady({
            session,
            expectedHappySessionId: 'happy-1',
            providerSessionId: 'provider-1',
            expectedProviderSessionId: 'provider-1',
            onUserMessage: vi.fn(),
        });

        expect(order).toEqual(['consumer', 'metadata', 'daemon']);
        expect(session.enableDaemonSessionTracking).toHaveBeenCalledWith('provider-1');
    });

    it('does not register the daemon when provider metadata cannot be persisted', async () => {
        const session = createSession({
            updateMetadata: vi.fn().mockRejectedValue(new Error('metadata timeout')),
        });
        await expect(completeProviderInputReady({
            session,
            expectedHappySessionId: 'happy-1',
            providerSessionId: 'provider-1',
            onUserMessage: vi.fn(),
        })).rejects.toThrow('metadata timeout');
        expect(session.onUserMessage).toHaveBeenCalledOnce();
        expect(session.enableDaemonSessionTracking).not.toHaveBeenCalled();
    });
});
