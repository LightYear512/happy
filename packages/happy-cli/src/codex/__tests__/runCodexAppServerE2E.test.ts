import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import type { UserMessage } from '@/api/types';
import type { Credentials } from '@/persistence';

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
const TURN_DELIM = '@@TURN@@'; // plain-ASCII record separator (avoids escaping traps)

class FakeSession extends EventEmitter {
    readonly sessionId = 'fake-session-id';
    readonly sessionEvents: Array<{ type: string; message?: string }> = [];
    readonly rpcHandlers = new Map<string, (params: unknown) => unknown>();
    readonly rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: unknown) => unknown): void => {
            this.rpcHandlers.set(method, handler);
        },
    };
    private cb: ((message: UserMessage) => void) | null = null;
    private pending: UserMessage[] = [];

    constructor() {
        super();
    }

    onUserMessage(callback: (data: UserMessage) => void): void {
        this.cb = callback;
        while (this.pending.length > 0) callback(this.pending.shift()!);
    }
    injectPendingMessage(message: UserMessage): void {
        if (this.cb) this.cb(message);
        else this.pending.push(message);
    }
    sendUserText(text: string): void {
        this.injectPendingMessage({ role: 'user', content: { type: 'text', text } });
    }
    sendSessionEvent(event: { type: string; message?: string }): void { this.sessionEvents.push(event); }
    sendCodexMessage(): void {}
    sendSessionProtocolMessage(): void {}
    sendClaudeSessionMessage(): void {}
    keepAlive(): void {}
    sendSessionDeath(): void {}
    updateMetadata(): void {}
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

    beforeEach(async () => {
        envScope.save();
        codexHome = await mkdtemp(join(tmpdir(), 'e2e-codexhome-'));
        projectCwd = await mkdtemp(join(tmpdir(), 'e2e-cwd-'));
        binDir = await mkdtemp(join(tmpdir(), 'e2e-bin-'));
        turnLog = join(binDir, 'turns.log');
    });
    afterEach(async () => {
        envScope.restore();
        delete process.env.HAPPY_TEST_TURN_LOG;
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
                'const turnLog = process.env.HAPPY_TEST_TURN_LOG;',
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
                '  if (msg.method === "thread/resume") { const tid = (msg.params && msg.params.threadId) || threadIds[0]; reply(msg.id, { threadId: tid }); continue; }',
                '  if (msg.method === "turn/start") {',
                '    const turnId = "turn-" + (nextTurn++);',
                '    const threadId = msg.params && msg.params.threadId;',
                '    const input = (msg.params && Array.isArray(msg.params.input)) ? msg.params.input : [];',
                '    const text = input.map((p) => (p && typeof p.text === "string") ? p.text : "").join("");',
                '    if (turnLog) { try { fs.appendFileSync(turnLog, text + DELIM); } catch {} }',
                '    reply(msg.id, { turnId });',
                '    notify("turn/started", { threadId, turn: { id: turnId } });',
                '    if (text.includes("__TRIGGER_COMPACT_FAIL__")) {',
                '      setTimeout(() => notify("error", {',
                '        error: { message: "Error running remote compact task: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses/compact)", codexErrorInfo: "other", additionalDetails: null },',
                '        willRetry: false, threadId, turnId,',
                '      }), 5);',
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
});
