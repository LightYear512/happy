import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

import { buildHeuristicSeed, SEED_SENTINEL } from '../utils/compactSeedBuilder';
import { compactViaCodexExec, wrapL2SeedAsHeuristicSeed } from '../utils/codexExecCompact';
import { loadFallbackCompactDocs, PROJECT_DOCS_OPEN } from '../utils/projectFallbackDocs';
import { shouldAutoRescue } from '../utils/codexAutoRescue';

const DOC_MARKER = 'FALLBACK_DOC_MARKER_九九八十一';

/**
 * End-to-end-ish check of the project fallback-docs feature along the REAL
 * trigger path, with real functions only — no mocked return values.
 *
 * Trigger: codex's SERVER-SIDE compact failure (the `willRetry:false` +
 * "Error running remote compact task" notification), which shouldAutoRescue
 * classifies → runManualCompact('compact', autoTriggered) → buildHeuristicSeed
 * → compactViaCodexExec (L2) → append loadFallbackCompactDocs.
 *
 * Both L2 branches spawn a REAL child through the production spawn path:
 *   - L2 SUCCESS: a working fake `codex exec` binary (codex's local exec is
 *     healthy in the real auto-rescue scenario — only the server compact failed).
 *   - L2 FAILURE: a missing binary (instant ENOENT).
 * runManualCompact's own shell can't be invoked (testkit/README.md wall), so we
 * reproduce its compose orchestration; that boundary is held by the AST contract
 * in autoResumeAfterFallback.test.ts.
 */
describe('fallback-compact docs — real trigger path (codex server compact error)', () => {
    let rolloutDir: string;
    let projectDir: string;
    let binDir: string;

    beforeEach(async () => {
        rolloutDir = await mkdtemp(join(tmpdir(), 'fb-rollout-'));
        projectDir = await mkdtemp(join(tmpdir(), 'fb-proj-'));
        binDir = await mkdtemp(join(tmpdir(), 'fb-bin-'));
    });
    afterEach(async () => {
        for (const d of [rolloutDir, projectDir, binDir]) {
            await rm(d, { recursive: true, force: true });
        }
    });

    function userMsg(text: string) {
        return { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } };
    }
    function assistantMsg(text: string) {
        return { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } };
    }
    async function writeRollout(name: string, records: object[]): Promise<string> {
        const path = join(rolloutDir, `${name}.jsonl`);
        await writeFile(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
        return path;
    }
    async function writeProjectDoc(content: string): Promise<void> {
        await mkdir(join(projectDir, '.happy'), { recursive: true });
        await writeFile(join(projectDir, '.happy', 'on-fallback-compact.md'), content, 'utf-8');
    }
    async function buildConversation(): Promise<string> {
        const records: object[] = [];
        for (let i = 0; i < 12; i++) {
            records.push(userMsg(`用户的第 ${i} 个问题：关于模块 module${i}.ts 的实现，请结合现有架构详细说明取舍。`));
            records.push(assistantMsg(
                `针对 module${i}.ts 的分析：刻意写长的回答，覆盖设计动机、边界、性能与可维护性权衡，`
                + `以及与上下游模块的接口约定，确保启发式 seed 足够长，让 L2 压缩被真正触发而非短路跳过。`,
            ));
        }
        return writeRollout('conversation', records);
    }

    /**
     * A real, working fake `codex exec` binary: parses `-o <outFile>`, drains
     * stdin, writes `summary` to the out-file, exits 0 — exercising the real
     * compactViaCodexExec spawn/read path (Windows `.cmd` shim → node; sh wrapper
     * on POSIX). Lightweight enough to run under the full suite without the flaky
     * timeout-test interaction that was fixed in codexExecCompact.test.ts.
     */
    async function writeFakeCodexExec(summary: string): Promise<string> {
        const mjs = join(binDir, 'fake-codex.mjs');
        const src = [
            "import { writeFileSync } from 'node:fs';",
            'const args = process.argv.slice(2);',
            "const oIdx = args.indexOf('-o');",
            'const outFile = oIdx >= 0 ? args[oIdx + 1] : null;',
            "process.stdin.on('data', () => {});",
            "process.stdin.on('end', () => {",
            `  if (outFile) writeFileSync(outFile, ${JSON.stringify(summary)});`,
            '  process.exit(0);',
            '});',
            'process.stdin.resume();',
        ].join('\n');
        await writeFile(mjs, src, 'utf-8');
        if (platform() === 'win32') {
            const cmd = join(binDir, 'fake-codex.cmd');
            await writeFile(cmd, `@echo off\r\nnode "${mjs}" %*\r\n`, 'utf-8');
            return cmd;
        }
        const sh = join(binDir, 'fake-codex');
        await writeFile(sh, `#!/bin/sh\nexec node "${mjs}" "$@"\n`, 'utf-8');
        await chmod(sh, 0o755);
        return sh;
    }

    it('a real codex server-side compact error is what triggers the rescue (shouldAutoRescue=true)', () => {
        // Captured-shape codex compact failure (cf. codexAutoRescue.test.ts).
        // THIS — not a missing binary — is the real entry into fallback compaction.
        const codexCompactError = {
            error: {
                message: 'Error running remote compact task: stream disconnected before completion: '
                    + 'error sending request for url (https://chatgpt.com/backend-api/codex/responses/compact)',
                codexErrorInfo: 'other',
                additionalDetails: null,
            },
            willRetry: false,
            threadId: '019dbd63-50f0-74d2-bffc-dec119b3371b',
            turnId: '019dbdb1-25a6-7e71-9b8e-ef50e8e22e66',
        };
        expect(shouldAutoRescue(codexCompactError), 'codex compact failure must trigger auto-rescue').toBe(true);
        // A transient one codex will retry itself must NOT trigger us.
        expect(shouldAutoRescue({ ...codexCompactError, willRetry: true })).toBe(false);
    });

    it('appends project docs on the L2-SUCCESS path with a REAL codex exec spawn, then strips next compaction', async () => {
        const rolloutPath = await buildConversation();
        await writeProjectDoc(`# 项目宪法\n本项目使用 codex app-server 后端。\n${DOC_MARKER}`);

        const built = await buildHeuristicSeed({ rolloutPath, trailerNote: '请基于以上摘要继续。', extraUserTexts: [] });

        // Real auto-rescue scenario: codex's local exec is healthy, only the
        // server compact failed → L2 SUCCEEDS. Spawn a real (fake) codex exec
        // through the production path so the summary is produced for real.
        const fakeBin = await writeFakeCodexExec(
            '这是 fake codex exec 进程产出的 L2 叙事摘要：用户希望在 fallback 压缩时注入项目级固定文档，'
            + '已实现哨兵包裹、高置信脱敏与下一轮剥离防膨胀；结论是该机制在 L2 成功与失败两条路径上都会附加文档。',
        );
        const l2 = await compactViaCodexExec({ heuristicSeed: built.seedText, codexBin: fakeBin, timeoutMs: 20_000 });
        expect(l2.summary, 'L2 must SUCCEED with a working (fake) codex exec').not.toBeNull();
        expect(l2.skipped, 'a real success, not a short-circuit').toBeUndefined();

        // runManualCompact's L2-success compose branch (wrap summary + verbatim
        // recent block) + the append.
        const body = built.recentBlock ? `${l2.summary}\n${built.recentBlock}` : (l2.summary as string);
        let seedText = wrapL2SeedAsHeuristicSeed(body, '请基于以上摘要继续。');
        seedText += await loadFallbackCompactDocs(projectDir);

        expect(seedText).toContain(PROJECT_DOCS_OPEN);
        expect(seedText).toContain(DOC_MARKER);
        expect(seedText.startsWith(SEED_SENTINEL), 'still a valid SEED envelope').toBe(true);

        // Next compaction strips the docs (anti-accumulation).
        const nextRollout = await writeRollout('next', [userMsg(seedText), userMsg('继续')]);
        const nextSeed = await buildHeuristicSeed({ rolloutPath: nextRollout, trailerNote: '请基于以上摘要继续。', extraUserTexts: [] });
        expect(nextSeed.seedText, 'docs stripped on the next compaction').not.toContain(DOC_MARKER);
        expect(nextSeed.seedText).not.toContain(PROJECT_DOCS_OPEN);
    }, 30_000);

    it('appends docs on the L2-FAILURE path too — a real (missing) exec → append is independent of L2', async () => {
        const rolloutPath = await buildConversation();
        await writeProjectDoc(`# 项目宪法\n${DOC_MARKER}`);

        const built = await buildHeuristicSeed({ rolloutPath, trailerNote: '请基于以上摘要继续。', extraUserTexts: [] });
        // Real spawn of a missing binary → instant ENOENT → genuine L2 failure
        // (light: no node child is started).
        const l2 = await compactViaCodexExec({
            heuristicSeed: built.seedText,
            codexBin: join(rolloutDir, 'no-such-codex-binary'),
            timeoutMs: 15_000,
        });
        expect(l2.summary, 'L2 fails when its own exec is missing').toBeNull();
        expect(l2.skipped, 'a real failure, not a short-circuit').toBeUndefined();

        // L2-failure compose branch: keep the heuristic seed, then append docs.
        let seedText = built.seedText;
        seedText += await loadFallbackCompactDocs(projectDir);
        expect(seedText).toContain(DOC_MARKER);
        expect(seedText).toContain(PROJECT_DOCS_OPEN);
    }, 20_000);
});
