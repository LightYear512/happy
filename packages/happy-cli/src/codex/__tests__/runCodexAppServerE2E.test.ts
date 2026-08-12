import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { runCodexWithAppServer } from '../runCodexAppServer';
import {
    writeFakeCodexAppServerScript,
    createCodexAppServerTestEnvScope,
} from './testkit/fakeCodexAppServer';
import type { ApiSessionClient } from '@/api/apiSession';
import type { ApiClient } from '@/api/api';
import type { Metadata, UserMessage } from '@/api/types';
import type { Credentials } from '@/persistence';
import { publishAccountIntent, writeSessionAccountSelection } from '@/commands/bang/accountIntent';

/**
 * True end-to-end test of the codex fallback-compact docs injection along the
 * REAL runtime path (Gap 2): a fake `codex app-server` child speaks JSONRPC over
 * stdio, the runtime is driven via the `opts.deps` injection seam (no happy
 * server, no real codex), the fake emits a server-side compact-failure `error`
 * notification, and we assert the auto-rescue actually injects the project doc
 * (.happy/on-fallback-compact.md) into the NEXT turn/start the runtime sends.
 *
 * This exercises what the AST contract + compose integration test could only
 * approximate: error handler → shouldAutoRescue → runManualCompact → seed (+
 * docs) stashed in pendingSeedText → turn loop prepends it onto the
 * auto-replayed 继续 turn that codex actually receives.
 */

// Fixed UUIDs so the fake's thread/start ids match a pre-written rollout file
// (findRolloutByConversationId requires the `-<uuid>.jsonl` filename shape).
const THREAD_UUID_1 = '00000000-0000-4000-8000-000000000001';
const THREAD_UUID_2 = '00000000-0000-4000-8000-000000000002';
const THREAD_UUID_3 = '00000000-0000-4000-8000-000000000003';
const DOC_MARKER = 'E2E_DOC_MARKER_九九八十一';
const TRIGGER = '__TRIGGER_COMPACT_FAIL__';
const SUBAGENT_TRIGGER = '__SPAWN_SUBAGENT__';
const TURN_DELIM = '@@TURN@@'; // plain-ASCII record separator (avoids escaping traps)

class FakeSession extends EventEmitter {
    readonly sessionId = 'fake-session-id';
    readonly sessionEvents: Array<{ type: string; message?: string }> = [];
    readonly providerTurnEnds: Array<'completed' | 'failed' | 'cancelled'> = [];
    readonly codexMessages: unknown[] = [];
    readonly rpcHandlers = new Map<string, (params: unknown) => unknown>();
    metadata: Metadata = {
        path: '/workspace',
        host: 'test-host',
        homeDir: '/home/test',
        happyHomeDir: '/home/test/.happy',
        happyLibDir: '/happy/lib',
        happyToolsDir: '/happy/tools',
        flavor: 'codex',
        startedBy: 'daemon',
        hostPid: process.pid,
    };
    readonly rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: unknown) => unknown): void => {
            this.rpcHandlers.set(method, handler);
        },
    };
    private cb: ((message: UserMessage) => unknown | Promise<unknown>) | null = null;
    private pending: UserMessage[] = [];

    constructor() {
        super();
    }

    onUserMessage(callback: (data: UserMessage) => unknown | Promise<unknown>): void {
        this.cb = callback;
        while (this.pending.length > 0) void callback(this.pending.shift()!);
    }
    injectPendingMessage(message: UserMessage): void {
        if (this.cb) void this.cb(message);
        else this.pending.push(message);
    }
    sendUserText(text: string): void {
        this.injectPendingMessage({ role: 'user', content: { type: 'text', text } });
    }
    sendSplitUserText(displayText: string, modelText: string): void {
        this.injectPendingMessage({ role: 'user', content: { type: 'text', text: displayText },
            meta: { sentFrom: 'cli', modelText, displayText, presentation: 'compact' } });
    }
    sendSessionEvent(event: { type: string; message?: string }): void { this.sessionEvents.push(event); }
    closeProviderSessionTurn(status: 'completed' | 'failed' | 'cancelled'): void {
        this.providerTurnEnds.push(status);
    }
    sendCodexMessage(message: unknown): void { this.codexMessages.push(message); }
    sendSessionProtocolMessage(): void {}
    sendClaudeSessionMessage(): void {}
    keepAlive(): void {}
    sendSessionDeath(): void {}
    async updateMetadata(handler: (metadata: Metadata) => Metadata): Promise<void> {
        this.metadata = handler(this.metadata);
    }
    updateAgentState(): void {}
    async flush(): Promise<void> {}
    async close(): Promise<void> {}
}

const fakeApi = { push: () => ({ sendToAllDevices: () => {} }) } as unknown as ApiClient;

const envScope = createCodexAppServerTestEnvScope();

describe('runCodexWithAppServer — E2E fallback-compact docs injection (real turn loop)', () => {
    let codexHome: string;
    let projectCwd: string;
    let binDir: string;
    let turnLog: string;
    let threadTraceLog: string;
    let resumeTraceLog: string;

    beforeEach(async () => {
        envScope.save();
        codexHome = await mkdtemp(join(tmpdir(), 'e2e-codexhome-'));
        projectCwd = await mkdtemp(join(tmpdir(), 'e2e-cwd-'));
        binDir = await mkdtemp(join(tmpdir(), 'e2e-bin-'));
        turnLog = join(binDir, 'turns.log');
        threadTraceLog = join(binDir, 'thread-trace.jsonl');
        resumeTraceLog = join(binDir, 'resume-trace.jsonl');
    });
    afterEach(async () => {
        envScope.restore();
        delete process.env.HAPPY_TEST_TURN_LOG;
        delete process.env.HAPPY_TEST_THREAD_TRACE_LOG;
        delete process.env.HAPPY_TEST_REJECT_FIRST_TURN;
        delete process.env.HAPPY_TEST_RESUME_TRACE_LOG;
        delete process.env.HAPPY_TEST_REJECT_RESUME;
        delete process.env.HAPPY_TEST_RESUME_DELAY_MS;
        delete process.env.HAPPY_TEST_AGENT_MESSAGE_MODE;
        for (const d of [codexHome, projectCwd, binDir]) {
            await rm(d, { recursive: true, force: true });
        }
    });

    async function writeRollout(uuid: string): Promise<void> {
        // Short rollout → heuristic seed < MIN_SEED_CHARS_FOR_LLM (1500) → L2
        // short-circuits (no real `codex exec` spawn) → fast & deterministic.
        // Docs are appended regardless of the L2 outcome.
        const dir = join(codexHome, 'sessions', '2026', '01', '01');
        await mkdir(dir, { recursive: true });
        const records = [
            { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '用户先前的问题' }] } },
            { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '我先前的回答' }] } },
        ];
        await writeFile(join(dir, `rollout-2026-01-01T00-00-00-${uuid}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }

    async function writeFakeBin(): Promise<string> {
        // fake codex app-server. Uses console.log (auto-newline framing) and an
        // ASCII record separator so the script needs no backslash escapes.
        const mjs = await writeFakeCodexAppServerScript({
            dir: binDir,
            importLines: ['import fs from "node:fs";'],
            setupLines: [
                'let nextThread = 0;',
                `const threadIds = ${JSON.stringify([THREAD_UUID_1, THREAD_UUID_2, THREAD_UUID_3])};`,
                'let nextTurn = 1;',
                'let rejectTurnOnce = process.env.HAPPY_TEST_REJECT_FIRST_TURN === "1";',
                'const rejectResume = process.env.HAPPY_TEST_REJECT_RESUME === "1";',
                'const turnLog = process.env.HAPPY_TEST_TURN_LOG;',
                'const threadTraceLog = process.env.HAPPY_TEST_THREAD_TRACE_LOG;',
                'const resumeTraceLog = process.env.HAPPY_TEST_RESUME_TRACE_LOG;',
                'const resumeDelayMs = Number(process.env.HAPPY_TEST_RESUME_DELAY_MS || 0);',
                'const agentMessageMode = process.env.HAPPY_TEST_AGENT_MESSAGE_MODE || "";',
                `const DELIM = ${JSON.stringify(TURN_DELIM)};`,
            ],
            bodyLines: [
                'const send = (obj) => console.log(JSON.stringify(obj));',
                'const reply = (id, result) => send({ id, result });',
                'const notify = (method, params) => send({ method, params });',
                'for await (const line of rl) {',
                '  if (!line.trim()) continue;',
                '  let msg; try { msg = JSON.parse(line); } catch { continue; }',
                '  if (msg.method === "initialize") { reply(msg.id, { serverInfo: { name: "fake-codex", version: "0.0.0" } }); continue; }',
                '  if (msg.method === "initialized") continue;',
                '  if (msg.method === "thread/start") { reply(msg.id, { threadId: threadIds[Math.min(nextThread++, threadIds.length - 1)] }); continue; }',
                '  if (msg.method === "thread/resume") {',
                '    const tid = (msg.params && msg.params.threadId) || threadIds[0];',
                '    if (resumeTraceLog) { try { fs.appendFileSync(resumeTraceLog, JSON.stringify({ threadId: tid, excludeTurns: msg.params && msg.params.excludeTurns }) + "\\n"); } catch {} }',
                '    if (rejectResume) { send({ id: msg.id, error: { code: -32000, message: "no rollout found for thread id " + tid } }); continue; }',
                '    if (resumeDelayMs > 0) { setTimeout(() => reply(msg.id, { threadId: tid }), resumeDelayMs); }',
                '    else { reply(msg.id, { threadId: tid }); }',
                '    continue;',
                '  }',
                '  if (msg.method === "turn/start") {',
                '    const turnId = "turn-" + (nextTurn++);',
                '    const threadId = msg.params && msg.params.threadId;',
                '    const input = (msg.params && Array.isArray(msg.params.input)) ? msg.params.input : [];',
                '    const text = input.map((p) => (p && typeof p.text === "string") ? p.text : "").join("");',
                '    if (turnLog) { try { fs.appendFileSync(turnLog, text + DELIM); } catch {} }',
                '    if (threadTraceLog) { try { fs.appendFileSync(threadTraceLog, JSON.stringify({ threadId, text, codexHome: process.env.CODEX_HOME }) + "\\n"); } catch {} }',
                '    if (rejectTurnOnce) { rejectTurnOnce = false; send({ id: msg.id, error: { code: -32000, message: "injected first turn rejection" } }); continue; }',
                '    if (threadId === "child-thread") { reply(msg.id, { error: { message: "direct app-server input is not allowed for multi-agent v2 sub-agents" } }); continue; }',
                '    reply(msg.id, { turnId });',
                '    notify("turn/started", { threadId, turn: { id: turnId } });',
                '    if (text.includes("__SPAWN_SUBAGENT__")) {',
                '      setTimeout(() => notify("turn/started", { threadId: "child-thread", turn: { id: "child-turn" } }), 1);',
                '      setTimeout(() => notify("turn/completed", { threadId: "child-thread", turn_id: "child-turn" }), 3);',
                '      setTimeout(() => notify("turn/completed", { threadId, turn_id: turnId }), 8);',
                '    } else if (text.includes("__TRIGGER_COMPACT_FAIL__")) {',
                '      setTimeout(() => notify("error", {',
                '        error: { message: "Error running remote compact task: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses/compact)", codexErrorInfo: "other", additionalDetails: null },',
                '        willRetry: false, threadId, turnId,',
                '      }), 5);',
                '    } else if (agentMessageMode === "delta-only") {',
                '      setTimeout(() => notify("item/agentMessage/delta", { threadId, turnId, delta: "FINAL_DELTA_ONLY" }), 1);',
                '      setTimeout(() => notify("item/completed", { threadId, turnId, item: { id: "final-message", type: "agentMessage" } }), 3);',
                '      setTimeout(() => notify("turn/completed", { threadId, turn_id: turnId }), 5);',
                '    } else if (agentMessageMode === "completed-text") {',
                '      setTimeout(() => notify("item/agentMessage/delta", { threadId, turnId, delta: "FINAL_COMPLETED_TEXT" }), 1);',
                '      setTimeout(() => notify("item/completed", { threadId, turnId, item: { id: "final-message", type: "agentMessage", text: "FINAL_COMPLETED_TEXT" } }), 3);',
                '      setTimeout(() => notify("turn/completed", { threadId, turn_id: turnId, lastAgentMessage: "FINAL_COMPLETED_TEXT" }), 5);',
                '    } else {',
                '      setTimeout(() => notify("turn/completed", { threadId, turn_id: turnId }), 5);',
                '    }',
                '    continue;',
                '  }',
                '  if (msg.id !== undefined && msg.id !== null) { send({ id: msg.id, error: { code: -32601, message: "method not found: " + msg.method } }); }',
                '}',
            ],
        });
        if (platform() === 'win32') {
            const cmd = join(binDir, 'fake-codex-app-server.cmd');
            const CRLF = String.fromCharCode(13, 10);
            await writeFile(cmd, `@echo off${CRLF}node "${mjs}" %*${CRLF}`, 'utf-8');
            return cmd;
        }
        await chmod(mjs, 0o755);
        return mjs;
    }

    async function readTurnRecords(): Promise<string[]> {
        try {
            const raw = await readFile(turnLog, 'utf-8');
            return raw.split(TURN_DELIM).map((r) => r.trim()).filter((r) => r.length > 0);
        } catch {
            return [];
        }
    }

    async function readThreadTraces(): Promise<Array<{ threadId: string; text: string; codexHome?: string }>> {
        try {
            const raw = await readFile(threadTraceLog, 'utf-8');
            return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        } catch {
            return [];
        }
    }

    async function readResumeTraces(): Promise<Array<{ threadId: string; excludeTurns?: boolean }>> {
        try {
            const raw = await readFile(resumeTraceLog, 'utf-8');
            return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        } catch {
            return [];
        }
    }

    it.each([
        ['delta-only', 'FINAL_DELTA_ONLY'],
        ['completed-text', 'FINAL_COMPLETED_TEXT'],
    ])('delivers the final agent message exactly once for %s protocol output', async (mode, expectedText) => {
        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '4000';
        process.env.HAPPY_TEST_AGENT_MESSAGE_MODE = mode;
        process.env.CODEX_HOME = codexHome;

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        let resolveReady: (() => void) | undefined;
        const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
        const runtime = runCodexWithAppServer({
            credentials: {} as Credentials,
            deps: {
                apiClient: fakeApi,
                session: fakeSession as unknown as ApiSessionClient,
                cwd: projectCwd,
                onRuntimeReady: ({ requestExit: close }) => {
                    requestExit = close;
                    resolveReady?.();
                },
            },
        });

        await ready;
        fakeSession.sendUserText('emit final answer');
        const deadline = Date.now() + 4_000;
        while (Date.now() < deadline) {
            const delivered = fakeSession.codexMessages.filter((message) =>
                typeof message === 'object'
                && message !== null
                && (message as { type?: unknown }).type === 'message'
                && (message as { message?: unknown }).message === expectedText);
            if (delivered.length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await new Promise((resolve) => setTimeout(resolve, 30));

        const delivered = fakeSession.codexMessages.filter((message) =>
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'message'
            && (message as { message?: unknown }).message === expectedText);
        expect(delivered).toHaveLength(1);

        requestExit?.();
        await runtime;
    });

    it('resumes the exact restored thread before runtime readiness or queued input', async () => {
        const startupDirectory = join(projectCwd, 'xcoding-v2', 'dist');
        await mkdir(startupDirectory, { recursive: true });
        await writeFile(join(startupDirectory, 'cli.js'),
            `process.stdout.write(JSON.stringify({ systemMessage: '旧版本已迁移:' + process.env.XC_CONVERSATION_ID }));\n`);
        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '4000';
        process.env.CODEX_HOME = codexHome;
        process.env.HAPPY_TEST_RESUME_TRACE_LOG = resumeTraceLog;

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        let resolveReady: (() => void) | undefined;
        const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
        const runtime = runCodexWithAppServer({
            credentials: {} as Credentials,
            startedBy: 'daemon',
            restoreSessionId: fakeSession.sessionId,
            codexSessionId: THREAD_UUID_1,
            deps: {
                apiClient: fakeApi,
                session: fakeSession as unknown as ApiSessionClient,
                cwd: projectCwd,
                onRuntimeReady: ({ requestExit: close }) => {
                    requestExit = close;
                    resolveReady?.();
                },
            },
        });

        await ready;
        expect(await readResumeTraces()).toEqual([{ threadId: THREAD_UUID_1, excludeTurns: true }]);
        expect(await readTurnRecords()).toEqual([]);
        expect(fakeSession.metadata.claudeSessionId).toBeUndefined();
        requestExit?.();
        await runtime;
        expect(fakeSession.sessionEvents).not.toContainEqual(expect.objectContaining({
            type: 'message', message: expect.stringContaining('旧版本已迁移'),
        }));
    });

    it('rejects a missing restored rollout before exposing runtime readiness', async () => {
        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '4000';
        process.env.HAPPY_TEST_RESUME_TRACE_LOG = resumeTraceLog;
        process.env.HAPPY_TEST_REJECT_RESUME = '1';
        process.env.CODEX_HOME = codexHome;

        const fakeSession = new FakeSession();
        let becameReady = false;
        await runCodexWithAppServer({
            credentials: {} as Credentials,
            startedBy: 'daemon',
            restoreSessionId: fakeSession.sessionId,
            codexSessionId: THREAD_UUID_1,
            deps: {
                apiClient: fakeApi,
                session: fakeSession as unknown as ApiSessionClient,
                cwd: projectCwd,
                onRuntimeReady: () => { becameReady = true; },
            },
        });

        expect(becameReady).toBe(false);
        expect(await readResumeTraces()).toEqual([{ threadId: THREAD_UUID_1, excludeTurns: true }]);
        expect(await readTurnRecords()).toEqual([]);
        expect(fakeSession.sessionEvents).toContainEqual(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('no rollout found for thread id'),
        }));
    });

    it('leaves restored-thread XC startup to the shared ApiSession boundary', async () => {
        const startupDirectory = join(projectCwd, 'xcoding-v2', 'dist');
        await mkdir(startupDirectory, { recursive: true });
        await writeFile(join(startupDirectory, 'cli.js'),
            `process.stdout.write(JSON.stringify({ systemMessage: '旧版本已迁移:' + process.env.XC_CONVERSATION_ID }));\n`);
        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '4000';
        process.env.CODEX_HOME = codexHome;

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        const ready = new Promise<void>((resolve) => {
            void runCodexWithAppServer({
                credentials: {} as Credentials,
                codexSessionId: THREAD_UUID_1,
                deps: {
                    apiClient: fakeApi,
                    session: fakeSession as unknown as ApiSessionClient,
                    cwd: projectCwd,
                    onRuntimeReady: ({ requestExit: close }) => { requestExit = close; resolve(); },
                },
            });
        });

        await ready;
        requestExit?.();
        expect(fakeSession.sessionEvents).not.toContainEqual(expect.objectContaining({
            type: 'message', message: expect.stringContaining('旧版本已迁移'),
        }));
    });

    // BUG-HAPPY-STARTUP diagnostic: reproduces the native-id/thread-id startup gap on the real turn loop.
    it('leaves fresh-thread XC startup to ApiSession and sends a lone @ directly to Codex', async () => {
        const startupDirectory = join(projectCwd, 'xcoding-v2', 'dist');
        await mkdir(startupDirectory, { recursive: true });
        await writeFile(join(startupDirectory, 'cli.js'),
            `process.stdout.write(process.argv[3] === 'startup'
  ? JSON.stringify({ systemMessage: 'XC_READY:' + process.env.XC_CONVERSATION_ID })
  : JSON.stringify({ hookSpecificOutput: { additionalContext: 'XC_FIRST_THREAD_CONTEXT' } }));\n`);
        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '4000';
        process.env.HAPPY_TEST_TURN_LOG = turnLog;
        process.env.CODEX_HOME = codexHome;

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        const ready = new Promise<void>((resolve) => {
            void runCodexWithAppServer({
                credentials: {} as Credentials,
                deps: {
                    apiClient: fakeApi,
                    session: fakeSession as unknown as ApiSessionClient,
                    cwd: projectCwd,
                    onRuntimeReady: ({ requestExit: close }) => { requestExit = close; resolve(); },
                },
            });
        });

        await ready;
        fakeSession.sendUserText('@');
        const deadline = Date.now() + 4_000;
        let records: string[] = [];
        while (Date.now() < deadline) {
            records = await readTurnRecords();
            if (records.length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        requestExit?.();
        expect(fakeSession.sessionEvents).not.toContainEqual(expect.objectContaining({
            type: 'message', message: expect.stringContaining('XC_READY'),
        }));
        expect(records).toHaveLength(1);
        expect(records[0]).not.toContain('XC_FIRST_THREAD_CONTEXT');
        expect(records[0]).toMatch(/\n\n@$/u);
    });

    it('prepares a daemon Codex provider identity before the first turn', async () => {
        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '4000';
        process.env.HAPPY_TEST_TURN_LOG = turnLog;
        process.env.CODEX_HOME = codexHome;

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        const ready = new Promise<void>((resolve) => {
            void runCodexWithAppServer({
                credentials: {} as Credentials,
                startedBy: 'daemon',
                deps: {
                    apiClient: fakeApi,
                    session: fakeSession as unknown as ApiSessionClient,
                    cwd: projectCwd,
                    onRuntimeReady: ({ requestExit: close }) => {
                        requestExit = close;
                        resolve();
                    },
                },
            });
        });

        await ready;
        expect(fakeSession.metadata.claudeSessionId).toBe(THREAD_UUID_1);
        expect(await readTurnRecords()).toEqual([]);
        requestExit?.();
    });

    it('never invokes the XC input hook when a provider turn is retried', async () => {
        const startupDirectory = join(projectCwd, 'xcoding-v2', 'dist');
        const inputCalls = join(projectCwd, 'xc-input-calls.txt');
        await mkdir(startupDirectory, { recursive: true });
        await writeFile(join(startupDirectory, 'cli.js'),
            `import { appendFileSync } from 'node:fs';
if (process.argv[3] === 'input') appendFileSync(${JSON.stringify(inputCalls)}, 'input\\n');
process.stdout.write(process.argv[3] === 'startup'
  ? JSON.stringify({ systemMessage: 'XC_READY' })
  : JSON.stringify({ hookSpecificOutput: { additionalContext: 'RETRY_CONTEXT' } }));\n`);
        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '4000';
        process.env.HAPPY_TEST_TURN_LOG = turnLog;
        process.env.HAPPY_TEST_REJECT_FIRST_TURN = '1';
        process.env.CODEX_HOME = codexHome;

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        const ready = new Promise<void>((resolve) => {
            void runCodexWithAppServer({ credentials: {} as Credentials, deps: {
                apiClient: fakeApi, session: fakeSession as unknown as ApiSessionClient, cwd: projectCwd,
                onRuntimeReady: ({ requestExit: close }) => { requestExit = close; resolve(); },
            } });
        });
        await ready;
        fakeSession.sendUserText('REJECTED_PROMPT');
        await new Promise((resolve) => setTimeout(resolve, 100));
        fakeSession.sendUserText('RETRIED_PROMPT');
        const deadline = Date.now() + 4_000;
        let records: string[] = [];
        while (Date.now() < deadline) {
            records = await readTurnRecords();
            if (records.length >= 2) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        requestExit?.();

        await expect(readFile(inputCalls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(records).toHaveLength(2);
        expect(records[1]).not.toContain('RETRY_CONTEXT');
        expect(records[1]).toContain('RETRIED_PROMPT');
    });

    it('sends encrypted modelText to Codex while legacy clients retain the compact content text', async () => {
        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '4000';
        process.env.HAPPY_TEST_TURN_LOG = turnLog;
        process.env.CODEX_HOME = codexHome;

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        const ready = new Promise<void>((resolve) => {
            void runCodexWithAppServer({
                credentials: {} as Credentials,
                deps: {
                    apiClient: fakeApi,
                    session: fakeSession as unknown as ApiSessionClient,
                    cwd: projectCwd,
                    onRuntimeReady: ({ requestExit: close }) => { requestExit = close; resolve(); },
                },
            });
        });

        await ready;
        fakeSession.sendSplitUserText('VISIBLE_COMPACT_SUMMARY', 'MODEL_ONLY_COMPLETE_MAIL_BODY');
        const deadline = Date.now() + 4_000;
        let records: string[] = [];
        while (Date.now() < deadline) {
            records = await readTurnRecords();
            if (records.length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        requestExit?.();

        expect(records).toHaveLength(1);
        expect(records[0]).toContain('MODEL_ONLY_COMPLETE_MAIL_BODY');
        expect(records[0]).not.toContain('VISIBLE_COMPACT_SUMMARY');
    }, 10_000);

    it('routes a raw @ command to Codex when the message carries distinct model text', async () => {
        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '4000';
        process.env.HAPPY_TEST_TURN_LOG = turnLog;
        process.env.CODEX_HOME = codexHome;

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        const ready = new Promise<void>((resolve) => {
            void runCodexWithAppServer({
                credentials: {} as Credentials,
                deps: {
                    apiClient: fakeApi,
                    session: fakeSession as unknown as ApiSessionClient,
                    cwd: projectCwd,
                    onRuntimeReady: ({ requestExit: close }) => { requestExit = close; resolve(); },
                },
            });
        });

        await ready;
        const eventFloor = fakeSession.sessionEvents.length;
        fakeSession.sendSplitUserText('@', '[XC required context]\n\n@');
        const deadline = Date.now() + 4_000;
        while (Date.now() < deadline && fakeSession.sessionEvents.length === eventFloor) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        requestExit?.();

        const records = await readTurnRecords();
        expect(records).toHaveLength(1);
        expect(records[0]).toContain('[XC required context]');
        expect(records[0]).toContain('@');
    }, 10_000);

    it('emits a compact-failure error → auto-rescue injects .happy docs into the next turn/start', async () => {
        await writeRollout(THREAD_UUID_1);
        await mkdir(join(projectCwd, '.happy'), { recursive: true });
        await writeFile(join(projectCwd, '.happy', 'on-fallback-compact.md'), `# 项目宪法\n${DOC_MARKER}`, 'utf-8');

        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '4000';
        process.env.HAPPY_TEST_TURN_LOG = turnLog;
        process.env.CODEX_HOME = codexHome; // rollout root + makes L2 codex exec fail-fast

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        const ready = new Promise<void>((resolve) => {
            void runCodexWithAppServer({
                credentials: {} as Credentials,
                deps: {
                    apiClient: fakeApi,
                    session: fakeSession as unknown as ApiSessionClient,
                    cwd: projectCwd,
                    onRuntimeReady: ({ requestExit: re }) => { requestExit = re; resolve(); },
                },
            }).catch((err) => { console.error('[E2E] runtime threw:', err); });
        });

        await ready;
        fakeSession.sendUserText(TRIGGER);

        // Poll the turn log until a post-rescue turn carries the docs.
        const deadline = Date.now() + 20_000;
        let records: string[] = [];
        while (Date.now() < deadline) {
            records = await readTurnRecords();
            if (records.length >= 2 && records[records.length - 1].includes(DOC_MARKER)) break;
            await new Promise((r) => setTimeout(r, 100));
        }

        requestExit?.();

        expect(records.length, `turn records: ${JSON.stringify(records)}`).toBeGreaterThanOrEqual(2);
        expect(records[0]).toContain(TRIGGER);
        expect(records[records.length - 1]).toContain(DOC_MARKER);
        expect(records[records.length - 1]).toContain('<!--HAPPY-PROJECT-DOCS-v1-->');
    }, 30_000);

    it('keeps direct input and lifecycle on the root thread after a sub-agent turn', async () => {
        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '4000';
        process.env.HAPPY_TEST_TURN_LOG = turnLog;
        process.env.HAPPY_TEST_THREAD_TRACE_LOG = threadTraceLog;
        process.env.CODEX_HOME = codexHome;

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        let resolveReady: (() => void) | undefined;
        const runtimeReady = new Promise<void>((resolve) => { resolveReady = resolve; });
        const runtime = runCodexWithAppServer({
            credentials: {} as Credentials,
            deps: {
                apiClient: fakeApi,
                session: fakeSession as unknown as ApiSessionClient,
                cwd: projectCwd,
                onRuntimeReady: ({ requestExit: re }) => {
                    requestExit = re;
                    resolveReady?.();
                },
            },
        });

        await runtimeReady;
        fakeSession.sendUserText(SUBAGENT_TRIGGER);
        const firstDeadline = Date.now() + 4_000;
        while (Date.now() < firstDeadline) {
            if ((await readThreadTraces()).length >= 1) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        await new Promise((r) => setTimeout(r, 40));
        fakeSession.sendUserText('second-root-prompt');

        const secondDeadline = Date.now() + 4_000;
        let traces: Array<{ threadId: string; text: string }> = [];
        while (Date.now() < secondDeadline) {
            traces = await readThreadTraces();
            if (traces.length >= 2) break;
            await new Promise((r) => setTimeout(r, 20));
        }

        requestExit?.();
        await runtime;

        expect(traces).toHaveLength(2);
        expect(traces[0].text).toContain(SUBAGENT_TRIGGER);
        expect(traces[1].text).toContain('second-root-prompt');
        expect(traces[1].threadId).toBe(traces[0].threadId);
        expect(traces[1].threadId).not.toBe('child-thread');
    }, 15_000);

    it('switches the app-server account only after resuming the exact root thread', async () => {
        const happyHome = join(binDir, 'happy-home');
        const instances = join(happyHome, 'auth', 'codex', 'instances');
        const workHome = join(instances, 'work');
        const personalHome = join(instances, 'personal');
        await mkdir(workHome, { recursive: true });
        await mkdir(personalHome, { recursive: true });
        await writeFile(join(workHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'work-test-token' } }));
        await writeFile(join(personalHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'personal-test-token' } }));
        await writeFile(join(instances, 'config.yaml'), 'default: work\n');

        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '4000';
        process.env.HAPPY_TEST_THREAD_TRACE_LOG = threadTraceLog;
        process.env.HAPPY_HOME_DIR = happyHome;
        process.env.CODEX_HOME = workHome;

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        let resolveReady: (() => void) | undefined;
        const runtimeReady = new Promise<void>((resolve) => { resolveReady = resolve; });
        const runtime = runCodexWithAppServer({
            credentials: {} as Credentials,
            deps: {
                apiClient: fakeApi,
                session: fakeSession as unknown as ApiSessionClient,
                cwd: projectCwd,
                onRuntimeReady: ({ requestExit: re }) => {
                    requestExit = re;
                    resolveReady?.();
                },
            },
        });

        await runtimeReady;
        fakeSession.sendUserText('first-account-prompt');
        const firstDeadline = Date.now() + 4_000;
        while (Date.now() < firstDeadline) {
            if ((await readThreadTraces()).length >= 1) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        fakeSession.sendUserText('!auth personal');
        const swapDeadline = Date.now() + 8_000;
        while (Date.now() < swapDeadline) {
            if (fakeSession.sessionEvents.some((event) => event.message?.includes('Switched to "personal"'))) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        fakeSession.sendUserText('second-account-prompt');
        const secondDeadline = Date.now() + 4_000;
        let traces: Array<{ threadId: string; text: string; codexHome?: string }> = [];
        while (Date.now() < secondDeadline) {
            traces = await readThreadTraces();
            if (traces.length >= 2) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        requestExit?.();
        await runtime;

        expect(fakeSession.sessionEvents.some((event) => event.message?.includes('Switched to "personal"'))).toBe(true);
        expect(traces).toHaveLength(2);
        expect(traces[0].threadId).toBe(traces[1].threadId);
        expect(traces[0].codexHome).toBe(workHome);
        expect(traces[1].codexHome).toBe(personalHome);
    }, 20_000);

    it('does not wake an idle session for a global account target and switches before the next input', async () => {
        const happyHome = join(binDir, 'happy-home');
        const instances = join(happyHome, 'auth', 'codex', 'instances');
        const workHome = join(instances, 'work');
        const personalHome = join(instances, 'personal');
        await mkdir(workHome, { recursive: true });
        await mkdir(personalHome, { recursive: true });
        await writeFile(join(workHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'work-test-token' } }));
        await writeFile(join(personalHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'personal-test-token' } }));
        await writeFile(join(instances, 'config.yaml'), 'default: work\n');

        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '4000';
        process.env.HAPPY_TEST_THREAD_TRACE_LOG = threadTraceLog;
        process.env.HAPPY_TEST_RESUME_TRACE_LOG = resumeTraceLog;
        process.env.HAPPY_HOME_DIR = happyHome;
        process.env.CODEX_HOME = workHome;

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        let resolveReady: (() => void) | undefined;
        const runtimeReady = new Promise<void>((resolve) => { resolveReady = resolve; });
        const runtime = runCodexWithAppServer({
            credentials: {} as Credentials,
            deps: {
                apiClient: fakeApi,
                session: fakeSession as unknown as ApiSessionClient,
                cwd: projectCwd,
                onRuntimeReady: ({ requestExit: re }) => {
                    requestExit = re;
                    resolveReady?.();
                },
            },
        });

        await runtimeReady;
        fakeSession.sendUserText('first-account-prompt');
        const firstDeadline = Date.now() + 4_000;
        while (Date.now() < firstDeadline) {
            if ((await readThreadTraces()).length >= 1) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        publishAccountIntent('codex', 'personal', Date.now(), happyHome);
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(await readResumeTraces()).toEqual([]);
        expect(fakeSession.sessionEvents.some((event) => event.message?.includes('Switched to "personal"'))).toBe(false);

        fakeSession.sendUserText('second-account-prompt');
        const secondDeadline = Date.now() + 8_000;
        let traces: Array<{ threadId: string; text: string; codexHome?: string }> = [];
        while (Date.now() < secondDeadline) {
            traces = await readThreadTraces();
            if (traces.length >= 2) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        requestExit?.();
        await runtime;

        expect(await readResumeTraces()).toEqual([{ threadId: traces[0]?.threadId, excludeTurns: true }]);
        expect(traces).toHaveLength(2);
        expect(traces[0].threadId).toBe(traces[1].threadId);
        expect(traces[0].codexHome).toBe(workHome);
        expect(traces[1].codexHome).toBe(personalHome);
    }, 20_000);

    it('uses a newer global account at startup instead of an unavailable saved account', async () => {
        const happyHome = join(binDir, 'happy-home');
        const instances = join(happyHome, 'auth', 'codex', 'instances');
        const unavailableHome = join(instances, 'deleted-manual');
        const personalHome = join(instances, 'personal');
        await mkdir(personalHome, { recursive: true });
        await writeFile(join(personalHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'personal-test-token' } }));
        await mkdir(instances, { recursive: true });
        await writeFile(join(instances, 'config.yaml'), 'default: deleted-manual\n');
        writeSessionAccountSelection('fake-session-id', 'codex', 'deleted-manual', 100, happyHome);
        publishAccountIntent('codex', 'personal', 101, happyHome);

        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '4000';
        process.env.HAPPY_TEST_THREAD_TRACE_LOG = threadTraceLog;
        process.env.HAPPY_HOME_DIR = happyHome;
        process.env.CODEX_HOME = unavailableHome;

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        let resolveReady: (() => void) | undefined;
        const runtimeReady = new Promise<void>((resolve) => { resolveReady = resolve; });
        const runtime = runCodexWithAppServer({
            credentials: {} as Credentials,
            deps: {
                apiClient: fakeApi,
                session: fakeSession as unknown as ApiSessionClient,
                cwd: projectCwd,
                onRuntimeReady: ({ requestExit: re }) => {
                    requestExit = re;
                    resolveReady?.();
                },
            },
        });

        await runtimeReady;
        fakeSession.sendUserText('startup-global-account');
        const deadline = Date.now() + 4_000;
        let traces: Array<{ threadId: string; text: string; codexHome?: string }> = [];
        while (Date.now() < deadline) {
            traces = await readThreadTraces();
            if (traces.length >= 1) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        requestExit?.();
        await runtime;

        expect(traces).toHaveLength(1);
        expect(traces[0].codexHome).toBe(personalHome);
        expect(traces[0].text).toContain('startup-global-account');
    }, 15_000);

    it('uses the canonical RPC timeout for account swap and keeps the old account usable on timeout', async () => {
        const happyHome = join(binDir, 'happy-home');
        const instances = join(happyHome, 'auth', 'codex', 'instances');
        const workHome = join(instances, 'work');
        const personalHome = join(instances, 'personal');
        await mkdir(workHome, { recursive: true });
        await mkdir(personalHome, { recursive: true });
        await writeFile(join(workHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'work-test-token' } }));
        await writeFile(join(personalHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'personal-test-token' } }));
        await writeFile(join(instances, 'config.yaml'), 'default: work\n');

        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '1000';
        process.env.HAPPY_TEST_RESUME_DELAY_MS = '1500';
        process.env.HAPPY_TEST_THREAD_TRACE_LOG = threadTraceLog;
        process.env.HAPPY_HOME_DIR = happyHome;
        process.env.CODEX_HOME = workHome;

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        let resolveReady: (() => void) | undefined;
        const runtimeReady = new Promise<void>((resolve) => { resolveReady = resolve; });
        const runtime = runCodexWithAppServer({
            credentials: {} as Credentials,
            deps: {
                apiClient: fakeApi,
                session: fakeSession as unknown as ApiSessionClient,
                cwd: projectCwd,
                onRuntimeReady: ({ requestExit: re }) => {
                    requestExit = re;
                    resolveReady?.();
                },
            },
        });

        await runtimeReady;
        fakeSession.sendUserText('first-account-prompt');
        const firstDeadline = Date.now() + 2_000;
        while (Date.now() < firstDeadline) {
            if ((await readThreadTraces()).length >= 1) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        fakeSession.sendUserText('!auth personal');
        const failureDeadline = Date.now() + 2_000;
        while (Date.now() < failureDeadline) {
            if (fakeSession.sessionEvents.some((event) => event.message?.includes('timed out after 1000ms'))) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        fakeSession.sendUserText('old-account-still-usable');
        const secondDeadline = Date.now() + 2_000;
        let traces: Array<{ threadId: string; text: string; codexHome?: string }> = [];
        while (Date.now() < secondDeadline) {
            traces = await readThreadTraces();
            if (traces.length >= 2) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        requestExit?.();
        await runtime;

        expect(fakeSession.sessionEvents.some((event) => event.message?.includes('timed out after 1000ms'))).toBe(true);
        expect(fakeSession.sessionEvents.some((event) => event.message?.includes('Switched to "personal"'))).toBe(false);
        expect(traces).toHaveLength(2);
        expect(traces[0].threadId).toBe(traces[1].threadId);
        expect(traces[0].codexHome).toBe(workHome);
        expect(traces[1].codexHome).toBe(workHome);
    }, 15_000);

    it('attempts a failed global account target once per input without using the old account', async () => {
        const happyHome = join(binDir, 'happy-home');
        const instances = join(happyHome, 'auth', 'codex', 'instances');
        const workHome = join(instances, 'work');
        const personalHome = join(instances, 'personal');
        await mkdir(workHome, { recursive: true });
        await mkdir(personalHome, { recursive: true });
        await writeFile(join(workHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'work-test-token' } }));
        await writeFile(join(personalHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'personal-test-token' } }));
        await writeFile(join(instances, 'config.yaml'), 'default: work\n');

        const fakeBin = await writeFakeBin();
        process.env.HAPPY_CODEX_APP_SERVER_BIN = fakeBin;
        process.env.HAPPY_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '1000';
        process.env.HAPPY_TEST_REJECT_RESUME = '1';
        process.env.HAPPY_TEST_THREAD_TRACE_LOG = threadTraceLog;
        process.env.HAPPY_TEST_RESUME_TRACE_LOG = resumeTraceLog;
        process.env.HAPPY_HOME_DIR = happyHome;
        process.env.CODEX_HOME = workHome;

        const fakeSession = new FakeSession();
        let requestExit: (() => void) | undefined;
        let resolveReady: (() => void) | undefined;
        const runtimeReady = new Promise<void>((resolve) => { resolveReady = resolve; });
        const runtime = runCodexWithAppServer({
            credentials: {} as Credentials,
            deps: {
                apiClient: fakeApi,
                session: fakeSession as unknown as ApiSessionClient,
                cwd: projectCwd,
                onRuntimeReady: ({ requestExit: re }) => {
                    requestExit = re;
                    resolveReady?.();
                },
            },
        });

        await runtimeReady;
        fakeSession.sendUserText('first-account-prompt');
        const firstDeadline = Date.now() + 2_000;
        while (Date.now() < firstDeadline) {
            if ((await readThreadTraces()).length >= 1) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        publishAccountIntent('codex', 'personal', Date.now(), happyHome);
        fakeSession.sendUserText('must-not-run-on-old-account');
        const failureDeadline = Date.now() + 2_000;
        while (Date.now() < failureDeadline) {
            if (fakeSession.sessionEvents.some((event) => event.message?.includes('本次输入未提交'))) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await new Promise((resolve) => setTimeout(resolve, 300));

        const traces = await readThreadTraces();
        const resumes = await readResumeTraces();
        requestExit?.();
        await runtime;

        expect(fakeSession.sessionEvents.some((event) => event.message?.includes('本次输入未提交'))).toBe(true);
        expect(resumes).toHaveLength(1);
        expect(resumes[0]?.excludeTurns).toBe(true);
        expect(traces).toHaveLength(1);
        expect(traces[0].text).toContain('first-account-prompt');
    }, 15_000);

});
