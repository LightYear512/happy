import { describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { OutgoingMessageQueue } from './utils/OutgoingMessageQueue';
import { SDKToLogConverter } from './utils/sdkToLogConverter';
import { closeClaudeTurnWithStatus, mapClaudeLogMessageToSessionEnvelopes } from './utils/sessionProtocolMapper';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/claude/sdk', () => ({ query, AbortError: class extends Error {} }));
vi.mock('@/lib', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn() } }));
vi.mock('@/projectPath', () => ({ projectPath: () => '/test/happy' }));
vi.mock('./utils/systemPrompt', () => ({ systemPrompt: 'test' }));

describe('Claude result publication boundary', () => {
    it.each([false, true])('finishes asynchronous result handling before accepting input (error=%s)', async (isError) => {
        query.mockImplementation(async function* () {
            yield { type: 'result', is_error: isError, subtype: isError ? 'error_during_execution' : 'success', result: 'final text' };
        });
        const events: string[] = [];
        let currentTurnId: string | null = null;
        const protocolEvents: string[] = [];
        const converter = new SDKToLogConverter({ sessionId: 'test-session', cwd: '/test', version: 'test', gitBranch: 'main' });
        const queue = new OutgoingMessageQueue(message => {
            const mapped = mapClaudeLogMessageToSessionEnvelopes(message, { currentTurnId });
            currentTurnId = mapped.currentTurnId;
            protocolEvents.push(...mapped.envelopes.map(envelope => envelope.ev.t));
            events.push('published');
        });
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let started!: () => void;
        const finalizing = new Promise<void>(resolve => { started = resolve; });
        const close = async () => {
            started();
            await gate;
            await queue.flush();
            const closed = closeClaudeTurnWithStatus({ currentTurnId }, isError ? 'failed' : 'completed');
            currentTurnId = closed.currentTurnId;
            protocolEvents.push(...closed.envelopes.map(envelope => envelope.ev.t));
            events.push(isError ? 'failed' : 'completed');
        };
        const nextMessage = vi.fn()
            .mockResolvedValueOnce({ message: 'hello', mode: { permissionMode: 'default' } })
            .mockImplementation(async () => { events.push('next-input'); return null; });
        const run = claudeRemote({
            sessionId: null, path: '/test', hookSettingsPath: '/test/hooks.json',
            allowedTools: [], nextMessage, onReady: close, onErrorResult: close,
            onSessionFound: vi.fn(), isAborted: () => false,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            onMessage: message => queue.enqueue(converter.convert(message), { delay: 60_000 }),
        });
        try {
            await finalizing;
            await Promise.resolve();
            expect(nextMessage).toHaveBeenCalledTimes(1);
            expect(events).toEqual([]);
            release();
            await run;
            expect(events).toEqual(['published', isError ? 'failed' : 'completed', 'next-input']);
            await new Promise(resolve => setTimeout(resolve, 5));
            expect(currentTurnId).toBeNull();
            expect(protocolEvents).toEqual(['turn-start', 'text', 'turn-end']);
        } finally {
            release();
            await run;
            queue.destroy();
        }
    });
});
