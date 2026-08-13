import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, rm, chmod } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    compactViaCodexExec,
    renderCompactionResultMessage,
    wrapL2SeedAsHeuristicSeed,
} from './codexExecCompact';
import type { CodexExecCompactResult } from './codexExecCompact';
import { SEED_SENTINEL } from './compactSeedBuilder';
import { createDisposableTempDirectory } from '@/utils/disposableTemp';

/**
 * Detect whether the local environment can run `codex exec` against the
 * real OpenAI backend. Used to gate the integration test below.
 *
 * Two layers of opt-in are required to avoid surprising contributors:
 *   1. `codex` binary on PATH (cheap to check)
 *   2. `HAPPY_TEST_REAL_CODEX=1` env (explicit consent — burns API tokens
 *      and takes ~15-30 s per run, so default-off in CI).
 *
 * When set, the test additionally honors `HAPPY_TEST_CODEX_HOME` if the
 * user wants to point at a specific auth profile (e.g. their happy
 * `xie2` profile under ~/.happy/auth/codex/instances/).
 */
function realCodexEnabled(): boolean {
    if (process.env.HAPPY_TEST_REAL_CODEX !== '1') return false;
    const probe = spawnSync('codex', ['--version'], { encoding: 'utf-8' });
    return probe.status === 0;
}

describe('compactViaCodexExec', () => {
    it('short-circuits when heuristic seed is below threshold', async () => {
        const result = await compactViaCodexExec({
            heuristicSeed: 'too short to bother summarising',
        });
        expect(result.summary).toBeNull();
        expect(result.skipped).toBe('short_circuit');
        expect(result.error).toContain('threshold');
        // Short-circuit must be near-instant (no process spawn, no IO)
        expect(result.elapsedMs).toBeLessThan(50);
    });

    it('returns error result when codex binary is missing (does not throw)', async () => {
        const longSeed = 'x'.repeat(2000); // above MIN_SEED_CHARS_FOR_LLM
        const result = await compactViaCodexExec({
            heuristicSeed: longSeed,
            codexBin: '/path/that/does/not/exist/codex',
            timeoutMs: 5_000,
        });
        expect(result.summary).toBeNull();
        expect(result.skipped).toBeUndefined();
        expect(result.error).toBeDefined();
        // Either spawn ENOENT surfaces as "spawn failed" or as exit-code path
        const err = result.error ?? '';
        expect(
            err.includes('spawn') || err.includes('ENOENT') || err.includes('exited'),
        ).toBe(true);
    });

    it('respects timeout when child hangs', async () => {
        // A cross-platform fake codex: drain stdin, then hang forever so the
        // SIGTERM→SIGKILL timeout path is what ends it. The previous POSIX-only
        // `#!/bin/sh … sleep 60` did NOT hang on Windows (no shebang support):
        // the child exited at once, the out-file was never written, and the
        // test only "passed" when concurrent load happened to slow the child
        // past the 800ms timeout. Use a node hang script via the production
        // spawn path (.cmd shim on Windows, sh wrapper on POSIX).
        const dir = await createDisposableTempDirectory('happy-fake-codex');
        const hangMjs = join(dir, 'hang.mjs');
        await writeFile(hangMjs, 'process.stdin.resume();process.stdin.on("data",()=>{});setInterval(()=>{},1e9);\n');
        let fakeBin: string;
        if (platform() === 'win32') {
            fakeBin = join(dir, 'fake-codex.cmd');
            await writeFile(fakeBin, `@echo off\r\nnode "${hangMjs}" %*\r\n`);
        } else {
            fakeBin = join(dir, 'fake-codex');
            await writeFile(fakeBin, `#!/bin/sh\nexec node "${hangMjs}" "$@"\n`);
            await chmod(fakeBin, 0o755);
        }

        try {
            const longSeed = 'x'.repeat(2000);
            const result = await compactViaCodexExec({
                heuristicSeed: longSeed,
                codexBin: fakeBin,
                timeoutMs: 800,
            });
            expect(result.summary).toBeNull();
            expect(result.error).toContain('timed out');
            // SIGTERM + 2 s SIGKILL grace ≈ ~3 s ceiling
            expect(result.elapsedMs).toBeGreaterThanOrEqual(700);
            expect(result.elapsedMs).toBeLessThan(5_000);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('renderCompactionResultMessage', () => {
    // The shape of CodexExecCompactResult — keep these factories in sync
    // with the actual type so refactors that add fields fail loudly here.
    const successResult = (summary: string): CodexExecCompactResult => ({
        summary,
        elapsedMs: 12_345,
    });
    const shortCircuitResult = (): CodexExecCompactResult => ({
        summary: null,
        elapsedMs: 1,
        skipped: 'short_circuit',
        error: 'seed length 800 < threshold 1500',
    });
    const failureResult = (errMsg: string): CodexExecCompactResult => ({
        summary: null,
        elapsedMs: 30_000,
        error: errMsg,
    });

    it('returns the LLM summary verbatim on L2 success (no wrapping)', () => {
        const summary = '用户的核心意图是 X，关键文件是 Y，结论是 Z。';
        const msg = renderCompactionResultMessage(successResult(summary), 12345);
        expect(msg).toBe(summary);
    });

    it('reports "对话较短" when L2 was short-circuited', () => {
        const msg = renderCompactionResultMessage(shortCircuitResult(), 800);
        expect(msg).toContain('已使用本地启发式摘要');
        expect(msg).toContain('对话较短');
        expect(msg).toContain('800');
    });

    it('reports "LLM 摘要不可用" on any other L2 failure', () => {
        const msg = renderCompactionResultMessage(
            failureResult('codex exec exited 1; stderr tail: ...'),
            8005,
        );
        expect(msg).toContain('LLM 摘要不可用');
        expect(msg).toContain('已使用本地启发式摘要');
        expect(msg).toContain('8005');
    });

    it('does not leak internal error details (stderr / paths / exit codes) to the user', () => {
        // Defensive: if we ever accidentally f-string the raw error into
        // the user-facing message, this test catches it.
        const errMsg = 'codex exec exited 137; stderr tail: ECONNRESET wss://chatgpt.com/...';
        const msg = renderCompactionResultMessage(failureResult(errMsg), 8005);
        expect(msg).not.toContain('exited');
        expect(msg).not.toContain('stderr');
        expect(msg).not.toContain('chatgpt.com');
        expect(msg).not.toContain('ECONNRESET');
    });

    it('prefers summary over skipped/error when both are somehow set', () => {
        // Defensive against future regressions where compactViaCodexExec
        // accidentally returns a non-null summary alongside skipped.
        const malformed: CodexExecCompactResult = {
            summary: 'real summary content',
            elapsedMs: 1000,
            skipped: 'short_circuit',
            error: 'should be ignored',
        };
        const msg = renderCompactionResultMessage(malformed, 999);
        expect(msg).toBe('real summary content');
    });

    it('treats empty-string summary as failure (no empty chat bubble)', () => {
        // compactViaCodexExec normally guards this via MIN_OUTPUT_CHARS, but
        // we lock the contract here so a future relaxation of that guard
        // does NOT silently surface empty messages to the user. Matches the
        // caller's `if (l2.summary)` truthiness check at
        // runCodexAppServer.ts /compact.
        const empty: CodexExecCompactResult = { summary: '', elapsedMs: 100 };
        const msg = renderCompactionResultMessage(empty, 5000);
        expect(msg).not.toBe('');
        expect(msg).toContain('LLM 摘要不可用');
        expect(msg).toContain('5000');

        const emptyShortCircuit: CodexExecCompactResult = {
            summary: '',
            elapsedMs: 50,
            skipped: 'short_circuit',
            error: 'below threshold',
        };
        const msg2 = renderCompactionResultMessage(emptyShortCircuit, 800);
        expect(msg2).toContain('对话较短');
    });
});

describe('wrapL2SeedAsHeuristicSeed', () => {
    it('emits SEED_SENTINEL as the first line so next /compact detects it', () => {
        const seed = wrapL2SeedAsHeuristicSeed('a coherent summary body');
        expect(seed.startsWith(SEED_SENTINEL)).toBe(true);
    });

    it('preserves the original summary content verbatim', () => {
        const summary = '用户的核心意图是测试 L2 压缩管线，最终结论是可行。';
        const wrapped = wrapL2SeedAsHeuristicSeed(summary);
        expect(wrapped).toContain(summary);
    });

    it('includes the lossy-summary safety trailer to prevent false amnesia', () => {
        const seed = wrapL2SeedAsHeuristicSeed('summary');
        // Same contract as the heuristic DEFAULT_TRAILER
        expect(seed).toContain('请勿假设');
    });

    it('appends optional trailerNote after the default trailer', () => {
        const seed = wrapL2SeedAsHeuristicSeed('summary', '请基于以上摘要继续。');
        expect(seed).toContain('请基于以上摘要继续。');
        // trailerNote must come AFTER the safety trailer
        const safetyIdx = seed.indexOf('请勿假设');
        const noteIdx = seed.indexOf('请基于以上摘要继续。');
        expect(safetyIdx).toBeGreaterThan(0);
        expect(noteIdx).toBeGreaterThan(safetyIdx);
    });
});

/**
 * Real-API integration test. Disabled by default — opt in with:
 *
 *   HAPPY_TEST_REAL_CODEX=1 npx vitest run src/codex/utils/codexExecCompact.test.ts
 *
 * Optional: HAPPY_TEST_CODEX_HOME=/Users/.../.happy/auth/codex/instances/xie2
 * to use a specific happy auth profile instead of the default ~/.codex.
 *
 * What this guards: codex CLI updates that silently break our flag set
 * (model rename, web_search schema change, -o behaviour change, effort
 * value list change) — manifests would still produce green unit tests
 * since those use a fake binary. This test fails loud at the real
 * boundary, fulfilling the project "No mocking — tests make real API
 * calls" rule for this module.
 */
describe('compactViaCodexExec (real codex integration)', () => {
    it.skipIf(!realCodexEnabled())(
        'produces a coherent summary against the real codex backend',
        async () => {
            // Must be ≥ MIN_SEED_CHARS_FOR_LLM (1500) to avoid short-circuit.
            // Use a realistic-looking heuristic seed shape so the prompt
            // contract matches production input.
            const fakeHeuristicSeed = [
                SEED_SENTINEL,
                '## 上下文摘要（happy /compact 本地重建）',
                '',
                '### 用户指令时序（共 2 条，节选 2）',
                '- 帮我看一下 packages/happy-cli/src/codex/runCodexAppServer.ts 是怎么管理子进程的',
                '- 之前你提到 turn-lifecycle，能展开讲讲吗？',
                '',
                '### 我之前给出的关键回答（共 2 条，节选 2）',
                '- runCodexAppServer.ts 通过 codex app-server JSONRPC over stdio 管理子进程，关键模块包括 turn-lifecycle、permissionHandler、reasoningProcessor、diffProcessor。turn/start 是非阻塞 RPC，立即返回 turnId，真正的完成信号是后续的 turn/completed notification。',
                '- turn-lifecycle 状态机保证每个 turn 都有终端信号：turn/completed、turn/interrupted、error notification、RPC 失败。所有路径都路由到 turnLifecycle.finish，pending promise 永不挂起。',
                '',
                '### 涉及的文件路径（共 5）',
                '- packages/happy-cli/src/codex/runCodexAppServer.ts',
                '- packages/happy-cli/src/codex/codexAppServerClient.ts',
                '- packages/happy-cli/src/codex/appServerStreamBridge.ts',
                '- packages/happy-cli/src/codex/utils/permissionHandler.ts',
                '- packages/happy-cli/src/codex/utils/reasoningProcessor.ts',
                '',
                '---',
                '注意：以上摘要由 happy /compact 本地启发式生成，可能不完整。',
            ].join('\n');
            // Pad to clear the threshold without distorting the seed shape.
            const padded = fakeHeuristicSeed + '\n' + '0'.repeat(2000);

            const result = await compactViaCodexExec({
                heuristicSeed: padded,
                codexHome: process.env.HAPPY_TEST_CODEX_HOME,
                timeoutMs: 180_000, // generous: real network can hit retries
            });

            expect(result.skipped).toBeUndefined();
            expect(result.error, `codex exec failed: ${result.error}`).toBeUndefined();
            expect(result.summary).not.toBeNull();
            expect(result.summary!.length).toBeGreaterThan(100);
            // Coherent summary should mention at least one key file or
            // architectural concept from the input. Loose check — we don't
            // want to brittle-test exact wording.
            const s = result.summary!;
            const mentionedSomething =
                s.includes('runCodexAppServer') ||
                s.includes('turn-lifecycle') ||
                s.includes('codex') ||
                s.includes('app-server') ||
                s.includes('子进程');
            expect(mentionedSomething, `summary doesn't mention any input concept; got: ${s.slice(0, 200)}…`).toBe(true);
        },
        200_000, // vitest test timeout > our compactViaCodexExec timeout
    );
});
