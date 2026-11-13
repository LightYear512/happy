import { describe, expect, it, vi } from 'vitest';
import { completeProviderInputReady } from './completeProviderInputReady';

function createSession(overrides: Record<string, unknown> = {}) {
    return {
        sessionId: 'happy-1',
        onUserMessage: vi.fn(),
        reconcilePersistedInputs: vi.fn().mockResolvedValue('complete'),
        updateMetadata: vi.fn().mockResolvedValue(undefined),
        enableDaemonSessionTracking: vi.fn(),
        ...overrides,
    } as any;
}

describe('completeProviderInputReady', () => {
    it('starts one restore lookup after installing the consumer without waiting for it', async () => {
        const never = new Promise<void>(() => {});
        const session = createSession();
        session.reconcilePersistedInputs.mockReturnValue(never);
        const onUserMessage = vi.fn();
        await completeProviderInputReady({
            session,
            expectedHappySessionId: 'happy-1',
            reconcilePersistedInputs: true,
            onUserMessage,
        });

        expect(session.onUserMessage).toHaveBeenCalledWith(onUserMessage);
        expect(session.reconcilePersistedInputs).toHaveBeenCalledWith('restore');
        expect(session.enableDaemonSessionTracking).toHaveBeenCalledWith(undefined);
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

    it('refreshes restored lifecycle after readiness without changing the persisted identity or title', async () => {
        const order: string[] = [];
        const session = createSession({
            onUserMessage: vi.fn(() => order.push('consumer')),
            updateMetadata: vi.fn(async (handler) => {
                const before = Object.freeze({ flavor: 'codex', claudeSessionId: 'provider-1',
                    hostPid: -1, lifecycleState: 'archived', lifecycleStateSince: 1,
                    archivedBy: 'cli', archiveReason: 'User terminated',
                    summary: { text: 'XC title' }, titleAuthority: 'external' });
                const after = handler(before);
                expect(after).toMatchObject({ claudeSessionId: 'provider-1', hostPid: process.pid,
                    lifecycleState: 'running', summary: before.summary, titleAuthority: 'external' });
                expect(after.lifecycleStateSince).toBeGreaterThan(1);
                expect(after).not.toHaveProperty('archivedBy');
                expect(after).not.toHaveProperty('archiveReason');
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

        expect(order).toEqual(['consumer', 'daemon', 'metadata']);
        expect(session.enableDaemonSessionTracking).toHaveBeenCalledWith('provider-1');
    });

    it.each(['pending', 'rejected'])('does not wait for a %s restored lifecycle update', async (result) => {
        const session = createSession({ updateMetadata: vi.fn(() => result === 'pending'
            ? new Promise<void>(() => {}) : Promise.reject(new Error('metadata timeout'))) });
        await completeProviderInputReady({ session, expectedHappySessionId: 'happy-1',
            providerSessionId: 'provider-1', expectedProviderSessionId: 'provider-1',
            onUserMessage: vi.fn() });
        expect(session.enableDaemonSessionTracking).toHaveBeenCalledWith('provider-1');
    });

    it('does not reactivate a cancelled restore or a concurrently replaced provider', async () => {
        let cancelled = false;
        const session = createSession();
        await completeProviderInputReady({ session, expectedHappySessionId: 'happy-1',
            providerSessionId: 'provider-1', expectedProviderSessionId: 'provider-1',
            onUserMessage: vi.fn(), isCancelled: () => cancelled });
        const handler = session.updateMetadata.mock.calls[0][0];
        const replaced = { claudeSessionId: 'provider-2', lifecycleState: 'archived' };
        expect(handler(replaced)).toBe(replaced);
        cancelled = true;
        const archived = { claudeSessionId: 'provider-1', lifecycleState: 'archived' };
        expect(handler(archived)).toBe(archived);
    });

    it('persists a fresh provider identity before daemon bookkeeping', async () => {
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
            onUserMessage: vi.fn(),
        });

        expect(order).toEqual(['consumer', 'metadata', 'daemon']);
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
