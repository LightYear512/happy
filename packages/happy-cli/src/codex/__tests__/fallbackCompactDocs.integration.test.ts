import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
 * The true trigger is codex's SERVER-SIDE compact failure (the
 * `willRetry:false` + "Error running remote compact task" notification), which
 * shouldAutoRescue classifies → runManualCompact('compact', autoTriggered) →
 * buildHeuristicSeed → compactViaCodexExec (L2) → append loadFallbackCompactDocs.
 *
 * runManualCompact's own shell can't be invoked (testkit/README.md wall), so we
 * reproduce its compose orchestration with real functions. We deliberately do
 * NOT spawn a fake "successful" codex here: a heavy node child raced the
 * full-suite's timing tests. L2-success spawn is already covered by
 * codexExecCompact.test.ts's real-runtime test — so the L2-success case below
 * verifies the COMPOSE+APPEND step runManualCompact performs once a summary
 * exists, independent of how the summary was produced. The L2-FAILURE case
 * still spawns a real (missing) binary — that path is light (instant ENOENT).
 */
describe('fallback-compact docs — real trigger path (codex server compact error)', () => {
    let rolloutDir: string;
    let projectDir: string;

    beforeEach(async () => {
        rolloutDir = await mkdtemp(join(tmpdir(), 'fb-rollout-'));
        projectDir = await mkdtemp(join(tmpdir(), 'fb-proj-'));
    });
    afterEach(async () => {
        for (const d of [rolloutDir, projectDir]) {
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

    it('appends project docs on the L2-SUCCESS compose branch (the real auto-rescue scenario), then strips next compaction', async () => {
        const rolloutPath = await buildConversation();
        await writeProjectDoc(`# 项目宪法\n本项目使用 codex app-server 后端。\n${DOC_MARKER}`);

        const built = await buildHeuristicSeed({ rolloutPath, trailerNote: '请基于以上摘要继续。', extraUserTexts: [] });

        // In the real auto-rescue scenario codex's local exec is healthy and L2
        // succeeds. The L2 spawn itself is covered by codexExecCompact.test.ts's
        // real-runtime test; here we exercise runManualCompact's L2-success
        // compose branch (wrap summary + verbatim recent block) + the append.
        const l2Summary = '用户希望在 fallback 压缩时注入项目级固定文档；已实现哨兵包裹、高置信脱敏与下一轮剥离防膨胀。';
        const body = built.recentBlock ? `${l2Summary}\n${built.recentBlock}` : l2Summary;
        let seedText = wrapL2SeedAsHeuristicSeed(body, '请基于以上摘要继续。');

        // The feature under test: append the project doc.
        seedText += await loadFallbackCompactDocs(projectDir);

        expect(seedText).toContain(PROJECT_DOCS_OPEN);
        expect(seedText).toContain(DOC_MARKER);
        expect(seedText.startsWith(SEED_SENTINEL), 'still a valid SEED envelope').toBe(true);

        // Next compaction strips the docs (anti-accumulation).
        const nextRollout = await writeRollout('next', [userMsg(seedText), userMsg('继续')]);
        const nextSeed = await buildHeuristicSeed({ rolloutPath: nextRollout, trailerNote: '请基于以上摘要继续。', extraUserTexts: [] });
        expect(nextSeed.seedText, 'docs stripped on the next compaction').not.toContain(DOC_MARKER);
        expect(nextSeed.seedText).not.toContain(PROJECT_DOCS_OPEN);
    });

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
