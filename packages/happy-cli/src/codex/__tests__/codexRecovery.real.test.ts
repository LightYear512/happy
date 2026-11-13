/** Real Codex/OS lifecycle tests. No model turns, credentials, or protocol simulators. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createCodexAppServerClient, CodexAppServerRequestTimeout, codexRequestTimeout,
    type CodexAppServerClient } from '../codexAppServerClient';
import { CodexAccountSwapCancelled, performCodexAccountSwap, requireExactCodexThreadResume } from '../codexAccountSwap';
import { startCodexThread } from '../runCodexAppServer';
import { systemPrompt } from '@/claude/utils/systemPrompt';

describe.skipIf(process.platform === 'win32')('Codex recovery — real stdio and process groups', () => {
    let directory: string;
    const clients: CodexAppServerClient[] = [];
    beforeEach(async () => {
        directory = await mkdtemp('/private/tmp/xc-disposable/happy-codex-recovery-test.');
    });
    afterEach(async () => {
        const results = await Promise.allSettled(clients.splice(0).map((client) => client.dispose()));
        await rm(directory, { recursive: true });
        expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    });
    const create = async (options: { signal?: AbortSignal; deadlineAt?: number; home?: string;
        requestTimeoutMs?: number } = {}): Promise<CodexAppServerClient> => {
        const { home = join(directory, randomUUID()), ...clientOptions } = options;
        await mkdir(home, { recursive: true });
        const client = await createCodexAppServerClient({
            cwd: directory,
            processEnv: { PATH: process.env.PATH!, CODEX_HOME: home },
            ...clientOptions,
        });
        clients.push(client);
        return client;
    };
    const assertExited = (client: CodexAppServerClient): void => {
        const groups = execFileSync('ps', ['-A', '-o', 'pgid='], { encoding: 'utf8' })
            .trim().split(/\s+/u).map(Number);
        expect(client.processId).toBeGreaterThan(1);
        expect(groups.length).toBeGreaterThan(0);
        expect(groups.every(group => Number.isSafeInteger(group) && group > 0)).toBe(true);
        expect(groups).not.toContain(client.processId);
    };
    const stopBeforeResume = async (client: CodexAppServerClient, threadId: string): Promise<string> => {
        process.kill(-client.processId!, 'SIGSTOP');
        await client.request('thread/resume', { threadId, excludeTurns: true }, { timeoutMs: 40 });
        throw new Error('Stopped Codex unexpectedly acknowledged resume');
    };

    it('initializes the installed Codex, calls a real RPC, and retires its entire group', async () => {
        const client = await create();
        await expect(client.request('account/read', { refreshToken: false })).resolves.toHaveProperty('account');
        await client.dispose();
        assertExited(client);
        await expect(client.request('account/read')).rejects.toThrow('disposed');
    }, 20_000);

    it('initializes with the remaining recovery budget instead of the ordinary RPC cap', async () => {
        // Real process startup cannot fit in the ordinary 1ms RPC budget.
        // Only initialize inherits the recovery deadline; later calls can
        // still explicitly choose their own deadline-independent timeout.
        const client = await create({ requestTimeoutMs: 1, deadlineAt: Date.now() + 10_000 });
        await expect(client.request('account/read', { refreshToken: false }, { timeoutMs: 5_000 }))
            .resolves.toHaveProperty('account');
        await client.dispose();
        assertExited(client);
    }, 20_000);

    it('performs at most one cold retry after real resume timeouts and never returns a retired client', async () => {
        const old = await create();
        const candidates: CodexAppServerClient[] = [];
        const result = await performCodexAccountSwap({
            currentClient: old, threadId: randomUUID(), recoverResumeTimeout: true,
            createCandidate: async () => {
                const client = await create(); candidates.push(client); return client;
            },
            resumeCandidate: stopBeforeResume,
        });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('Two real timeouts must not commit');
        expect(result.error).toBeInstanceOf(CodexAppServerRequestTimeout);
        expect(result.client).toBeNull();
        expect(result.cleanupFailed).toBe(false);
        expect(candidates).toHaveLength(2);
        [old, ...candidates].forEach(assertExited);
    }, 25_000);

    it('keeps the current client on an actual resume rejection and does not retry a non-timeout', async () => {
        const old = await create();
        let created = 0;
        const result = await performCodexAccountSwap({
            currentClient: old, threadId: randomUUID(), recoverResumeTimeout: true,
            createCandidate: async () => { created += 1; return create(); },
            resumeCandidate: async (candidate, threadId) => {
                await candidate.request('thread/resume', { threadId, excludeTurns: true });
                throw new Error('A nonexistent provider thread must be rejected');
            },
        });
        expect(result.ok).toBe(false);
        expect(result.client).toBe(old);
        expect(created).toBe(1);
        await expect(old.request('account/read')).resolves.toHaveProperty('account');
    }, 20_000);

    it('preserves the original startup resume timeout without creating another candidate', async () => {
        let created = 0;
        const result = await performCodexAccountSwap({
            currentClient: null, threadId: randomUUID(), recoverResumeTimeout: false,
            createCandidate: async () => { created += 1; return create(); },
            resumeCandidate: stopBeforeResume,
        });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('Stopped Codex must time out');
        expect(result.error).toBeInstanceOf(CodexAppServerRequestTimeout);
        expect(result.error.message).toContain('thread/resume timed out');
        expect(result.cleanupFailed).toBe(false);
        expect(result.client).toBeNull();
        expect(created).toBe(1);
        clients.forEach(assertExited);
    }, 20_000);

    it('recovers the exact persisted thread after two timed-out clients have been retired', async () => {
        const home = join(directory, 'recoverable-account');
        const old = await create({ home });
        const id = await startCodexThread(old, {
            cwd: directory, approvalPolicy: 'never', sandbox: 'read-only', persistExtendedHistory: true,
        });
        const failed = await performCodexAccountSwap({
            currentClient: old, threadId: id, recoverResumeTimeout: true,
            createCandidate: () => create({ home }), resumeCandidate: stopBeforeResume,
        });
        expect(failed.ok).toBe(false);
        expect(failed.client).toBeNull();
        if (failed.ok) throw new Error('Stopped candidates must time out');
        expect(failed.cleanupFailed).toBe(false);
        const recovered = await performCodexAccountSwap({
            currentClient: failed.client, threadId: id, recoverResumeTimeout: true,
            createCandidate: () => create({ home }),
            resumeCandidate: async (candidate, threadId) => {
                const response = await candidate.request('thread/resume', { threadId, excludeTurns: true }) as {
                    thread: { id: string };
                };
                return requireExactCodexThreadResume(response.thread.id, threadId);
            },
        });
        if (!recovered.ok) throw recovered.error;
        expect(recovered.threadId).toBe(id);
        await expect(recovered.client.request('thread/read', { threadId: id, includeTurns: false }))
            .resolves.toHaveProperty('thread.id', id);
        assertExited(old);
    }, 25_000);

    it('restarts a production-created thread with zero user turns and preserves its exact identity', async () => {
        const home = join(directory, 'same-account');
        const old = await create({ home });
        const id = await startCodexThread(old, {
            cwd: directory, approvalPolicy: 'never', sandbox: 'read-only', persistExtendedHistory: true,
        });
        const result = await performCodexAccountSwap({
            currentClient: old, threadId: id, retireBeforeResume: true,
            createCandidate: () => create({ home }),
            resumeCandidate: async (candidate, threadId) => {
                const resumed = await candidate.request('thread/resume', { threadId, excludeTurns: true }) as { thread: { id: string } };
                return requireExactCodexThreadResume(resumed.thread.id, threadId);
            },
        });
        if (!result.ok) throw result.error;
        expect(result.ok).toBe(true);
        expect(result.threadId).toBe(id);
        assertExited(old);
        // Read only the real provider-emitted rollout; do not seed test history.
        const sessions = join(home, 'sessions');
        const rollouts = (await readdir(sessions, { recursive: true }))
            .filter((path) => path.endsWith(`${id}.jsonl`));
        expect(rollouts).toHaveLength(1);
        const records = (await readFile(join(sessions, rollouts[0]!), 'utf8')).trim().split('\n')
            .map((line) => JSON.parse(line) as { type: string; payload?: {
                type?: string; role?: string; content?: unknown;
                internal_chat_message_metadata_passthrough?: { content_item_kinds?: string[] };
            } });
        expect(records.some((record) => ['user_message', 'task_started'].includes(record.payload?.type ?? ''))).toBe(false);
        // Native Codex emits environment context with role=user. It is not a
        // submitted prompt; every such record must carry the native provenance.
        for (const record of records.filter((record) => record.payload?.role === 'user')) {
            expect(record.payload?.internal_chat_message_metadata_passthrough?.content_item_kinds)
                .toEqual(['environments.environment_context']);
        }
        const bootstrap = [{ type: 'input_text', text: systemPrompt }];
        const instructions = records.filter((record) => record.type === 'response_item'
            && record.payload?.role === 'developer' && JSON.stringify(record.payload.content) === JSON.stringify(bootstrap));
        expect(instructions).toHaveLength(1);
        expect(instructions[0]?.payload?.content).toEqual(bootstrap);
    }, 20_000);

    it('discards a superseded real candidate without retiring the current client', async () => {
        const old = await create();
        let selected = true;
        let candidate: CodexAppServerClient | undefined;
        const result = await performCodexAccountSwap({
            currentClient: old, threadId: null, isCurrent: () => selected,
            createCandidate: async () => { candidate = await create(); selected = false; return candidate; },
            resumeCandidate: async () => { throw new Error('No thread should be resumed'); },
        });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('Superseded candidate must not commit');
        expect(result.error).toBeInstanceOf(CodexAccountSwapCancelled);
        expect(result.client).toBe(old);
        assertExited(candidate!);
        await expect(old.request('account/read')).resolves.toHaveProperty('account');
    }, 20_000);

    it('never returns the disposed old client when cancelled during retirement', async () => {
        const old = await create();
        let selected = true;
        let candidate: CodexAppServerClient | undefined;
        const result = await performCodexAccountSwap({
            currentClient: old, threadId: null, isCurrent: () => selected,
            createCandidate: async () => { candidate = await create(); return candidate; },
            resumeCandidate: async () => { throw new Error('No thread should be resumed'); },
            onCurrentRetired: () => { selected = false; },
        });
        expect(result.ok).toBe(false);
        expect(result.client).toBeNull();
        assertExited(old);
        assertExited(candidate!);
    }, 20_000);

    it('honors one expired startup deadline and refuses a fresh default timeout', async () => {
        const deadlineAt = Date.now() - 1;
        expect(() => codexRequestTimeout(30_000, deadlineAt)).toThrow('deadline expired');
        await expect(create({ deadlineAt })).rejects.toThrow('deadline expired');
        expect(clients).toHaveLength(0);
    });

    it('cancels a live candidate and rejects a missing or changed provider identity', async () => {
        const controller = new AbortController();
        const client = await create({ signal: controller.signal });
        controller.abort();
        await client.dispose();
        assertExited(client);
        expect(() => requireExactCodexThreadResume(null, 'original')).toThrow('no thread id');
        expect(() => requireExactCodexThreadResume('different', 'original')).toThrow('identity mismatch');
        expect(requireExactCodexThreadResume('original', 'original')).toBe('original');
    }, 20_000);
});
