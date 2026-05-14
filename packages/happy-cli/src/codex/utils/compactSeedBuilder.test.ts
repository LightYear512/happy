import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildHeuristicSeed,
    SEED_SENTINEL,
    DEFAULT_TOKEN_BUDGET,
    TOKEN_CHAR_RATIO,
    DEFAULT_TRAILER,
    HEADER_OVERHEAD_RESERVE,
    SECTION_SEPARATOR_RESERVE,
    COMPACTED_ABS_CAP_RATIO,
} from './compactSeedBuilder';

function jsonl(records: object[]): string {
    return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

const baseTimestamp = '2026-04-24T11:09:53.194Z';

function userMessage(text: string) {
    return {
        timestamp: baseTimestamp,
        type: 'response_item',
        payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
        },
    };
}

function assistantFinal(text: string) {
    return {
        timestamp: baseTimestamp,
        type: 'response_item',
        payload: {
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text }],
        },
    };
}

function assistantCommentary(text: string) {
    return {
        timestamp: baseTimestamp,
        type: 'response_item',
        payload: {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text }],
        },
    };
}

function shellCall(command: string) {
    return {
        timestamp: baseTimestamp,
        type: 'response_item',
        payload: {
            type: 'function_call',
            name: 'shell_command',
            arguments: JSON.stringify({ command }),
            call_id: 'call_x',
        },
    };
}

function applyPatchCall(input: string) {
    return {
        timestamp: baseTimestamp,
        type: 'response_item',
        payload: {
            type: 'function_call',
            name: 'apply_patch',
            arguments: JSON.stringify({ input }),
            call_id: 'call_p',
        },
    };
}

function todoCall(todos: object[]) {
    return {
        timestamp: baseTimestamp,
        type: 'response_item',
        payload: {
            type: 'function_call',
            name: 'set_todos',
            arguments: JSON.stringify({ todos }),
            call_id: 'call_t',
        },
    };
}

function reasoning() {
    return {
        timestamp: baseTimestamp,
        type: 'response_item',
        payload: { type: 'reasoning', encrypted_content: 'gAAAAA...' },
    };
}

function functionOutput(output: string) {
    return {
        timestamp: baseTimestamp,
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_x', output },
    };
}

function compacted(replacementUsers: string[]) {
    return {
        timestamp: baseTimestamp,
        type: 'compacted',
        payload: {
            message: '',
            replacement_history: replacementUsers.map((t) => ({
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: t }],
            })),
        },
    };
}

describe('buildHeuristicSeed', () => {
    let dir: string;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'seed-test-'));
    });

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function writeRollout(name: string, records: object[]): Promise<string> {
        const path = join(dir, `rollout-${name}.jsonl`);
        await writeFile(path, jsonl(records));
        return path;
    }

    it('preserves user turns and final answers, drops commentary and reasoning', async () => {
        const path = await writeRollout('basic', [
            userMessage('first user instruction'),
            reasoning(),
            assistantCommentary('let me think...'),
            assistantFinal('here is the answer'),
            userMessage('second user instruction'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.stats.userTurns).toBe(2);
        expect(result.stats.finalAnswers).toBe(1);
        expect(result.seedText).toContain('first user instruction');
        expect(result.seedText).toContain('second user instruction');
        expect(result.seedText).toContain('here is the answer');
        expect(result.seedText).not.toContain('let me think');
        expect(result.seedText).not.toContain('gAAAAA');
    });

    it('filters out environment_context and permissions noise', async () => {
        const path = await writeRollout('noise', [
            userMessage('<environment_context>\n  <cwd>...</cwd>\n</environment_context>'),
            userMessage('<permissions instructions>\nFilesystem...'),
            userMessage('real user input'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.stats.userTurns).toBe(1);
        expect(result.seedText).toContain('real user input');
        expect(result.seedText).not.toContain('environment_context');
        expect(result.seedText).not.toContain('permissions instructions');
    });

    it('extracts file paths from shell command arguments', async () => {
        const path = await writeRollout('files', [
            userMessage('do something'),
            shellCall('cat src/index.ts && rg "foo" packages/cli/main.ts'),
            shellCall('echo hello > /tmp/out.log'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.stats.fileEdits).toBeGreaterThan(0);
        expect(result.seedText).toContain('src/index.ts');
        expect(result.seedText).toContain('main.ts');
    });

    it('captures the latest todos snapshot', async () => {
        const path = await writeRollout('todos', [
            userMessage('start'),
            todoCall([{ id: 1, content: 'old', status: 'completed' }]),
            todoCall([
                { id: 1, content: 'old', status: 'completed' },
                { id: 2, content: 'current', status: 'in_progress' },
            ]),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.seedText).toContain('current');
        expect(result.seedText).toContain('TODO');
    });

    it('reuses compacted record and discards earlier user turns', async () => {
        const path = await writeRollout('compacted', [
            userMessage('very old turn 1'),
            userMessage('very old turn 2'),
            compacted(['summary point A', 'summary point B']),
            userMessage('after-compact turn'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.stats.hadCompactedRecord).toBe(true);
        // post-compact user turn preserved
        expect(result.seedText).toContain('after-compact turn');
        // pre-compact user turns should be replaced by compacted summary
        expect(result.seedText).toContain('summary point A');
        expect(result.seedText).toContain('summary point B');
        expect(result.seedText).not.toContain('very old turn 1');
        expect(result.seedText).not.toContain('very old turn 2');
    });

    it('keeps only the latest compacted record across multiple compactions', async () => {
        const path = await writeRollout('multi-compact', [
            userMessage('phase 1 user'),
            compacted(['old summary']),
            userMessage('phase 2 user'),
            compacted(['fresh summary']),
            userMessage('phase 3 user'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.seedText).toContain('fresh summary');
        expect(result.seedText).not.toContain('old summary');
        expect(result.seedText).toContain('phase 3 user');
        expect(result.seedText).not.toContain('phase 1 user');
        expect(result.seedText).not.toContain('phase 2 user');
    });

    it('drops function_call_output and event_msg payloads (they bloat rollout but carry no seed value)', async () => {
        const path = await writeRollout('outputs', [
            userMessage('one'),
            shellCall('ls'),
            functionOutput('a 5MB blob of stdout that should never enter the seed'.repeat(100)),
            assistantFinal('done'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.seedText).not.toContain('5MB blob');
    });

    it('section-aware fallback drops early sections when total exceeds token budget', async () => {
        // 50 user turns × 2 KB each ≫ 4 KB budget. Most will land in early
        // region and be summarised; fallback should drop early sections
        // before touching the must-keep recent turns.
        const longText = 'x'.repeat(2000);
        const records: object[] = [];
        for (let i = 0; i < 50; i++) records.push(userMessage(`user ${i}: ${longText}`));
        const path = await writeRollout('overflow', records);

        const small = await buildHeuristicSeed({ rolloutPath: path, tokenBudget: 1000 });
        // Seed stays within budget (small slack for shrink warnings)
        expect(small.seedText.length).toBeLessThanOrEqual(1000 * 4 + 400);
        // Fallback observable via stats, not legacy "省略中间内容" marker
        expect(small.stats.fallbackTriggered).toBe(true);
        expect(small.stats.droppedSections.length).toBeGreaterThan(0);
        // Must-keep guarantee: the newest user message survives intact
        expect(small.seedText).toContain('user 49');
    });

    it('tolerates malformed json lines (partial last line during active codex writes)', async () => {
        const malformed
            = jsonl([userMessage('valid line')])
            + '{"timestamp": "incomplete';
        const path = join(dir, 'rollout-malformed.jsonl');
        await writeFile(path, malformed);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.stats.userTurns).toBe(1);
        expect(result.seedText).toContain('valid line');
    });

    it('emits trailerNote at end of seed when provided', async () => {
        const path = await writeRollout('trailer', [userMessage('hi')]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            trailerNote: '请基于以上摘要继续。',
        });
        expect(result.seedText.endsWith('请基于以上摘要继续。')).toBe(true);
    });

    it('emits default safety trailer to prevent false amnesia even without trailerNote', async () => {
        const path = await writeRollout('default-trailer', [userMessage('hi')]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.seedText).toContain('请勿假设');
        expect(result.seedText).toContain('happy /compact');
    });

    it('preserves long assistant final_answer head and tail (no silent 300-char cutoff)', async () => {
        // Engineering-grade answer: structured analysis, conclusion at the end
        const head = '问题分析：\n1. 第一个根因：日志路径错误\n2. 第二个根因：权限不足\n3. 第三个根因：缓存未刷新';
        const filler = 'x'.repeat(8000);
        const tail = '\n最终结论：必须重启服务并清空缓存目录 /var/cache/app';
        const longAnswer = head + '\n' + filler + tail;

        const path = await writeRollout('long-answer', [
            userMessage('帮我排查这个 bug'),
            assistantFinal(longAnswer),
            userMessage('好的，那下一步呢'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });

        // Head should survive (intent / problem statement)
        expect(result.seedText).toContain('问题分析');
        expect(result.seedText).toContain('日志路径错误');
        // Tail should survive (conclusion)
        expect(result.seedText).toContain('最终结论');
        expect(result.seedText).toContain('/var/cache/app');
    });

    it('force-keeps the most recent 3 user turns verbatim even if individually long', async () => {
        // Each ~3000 chars — current static cap (400) would have shredded these
        const longUser = (i: number) =>
            `用户长指令 #${i}: 详细描述了一个产品需求 ` + 'y'.repeat(2900) + ` end-of-${i}`;

        const path = await writeRollout('force-keep', [
            userMessage('ancient turn 0'),
            userMessage('ancient turn 1'),
            userMessage('ancient turn 2'),
            userMessage(longUser(3)),
            userMessage(longUser(4)),
            userMessage(longUser(5)), // most recent
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });

        // Most recent 3 must be present in full (head + tail markers both visible)
        for (const i of [3, 4, 5]) {
            expect(result.seedText).toContain(`用户长指令 #${i}`);
            expect(result.seedText).toContain(`end-of-${i}`);
        }
    });

    it('returns bucketUsage stats for observability', async () => {
        // bucketUsage describes the early/summarised region; disable
        // recent-turns reservation so this single-turn fixture lands in
        // the early region and exercises all buckets.
        const path = await writeRollout('usage', [
            userMessage('hello'),
            assistantFinal('world'),
            shellCall('ls src/foo.ts'),
            todoCall([{ id: 1, content: 'a', status: 'in_progress' }]),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path, recentTurnsToKeep: 0 });
        expect(result.stats.bucketUsage).toBeDefined();
        expect(result.stats.bucketUsage.user).toBeGreaterThan(0);
        expect(result.stats.bucketUsage.assistant).toBeGreaterThan(0);
        expect(result.stats.bucketUsage.files).toBeGreaterThan(0);
        expect(result.stats.bucketUsage.todos).toBeGreaterThan(0);
        expect(result.stats.bucketUsage.compacted).toBe(0);
    });

    it('handles empty rollout gracefully (no buckets at all)', async () => {
        const path = await writeRollout('empty', []);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.stats.userTurns).toBe(0);
        expect(result.stats.finalAnswers).toBe(0);
        // Header + default trailer still present
        expect(result.seedText).toContain('上下文摘要');
        expect(result.seedText).toContain('请勿假设');
    });

    it('preserves code blocks fully when assistant answer overflows budget (no splitting fences)', async () => {
        // Tiny budget forces truncation; the code block is the load-bearing part
        const intro = '问题分析：你的循环写错了。\n\n';
        const codeBlock = '```typescript\nfunction fix(arr: number[]) {\n  for (let i = 0; i < arr.length; i++) {\n    arr[i] = arr[i] * 2;\n  }\n  return arr;\n}\n```';
        const filler = '\n\n' + 'x'.repeat(8000) + '\n\n';
        const conclusion = '注意：这是核心修复，必须完整应用。';
        const longAnswer = intro + codeBlock + filler + conclusion;

        const path = await writeRollout('codeblock', [
            userMessage('帮我修一下这个 bug'),
            assistantFinal(longAnswer),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path, tokenBudget: 2000 });

        // Code block must appear verbatim — both fences and full body
        expect(result.seedText).toContain('```typescript');
        expect(result.seedText).toContain('function fix(arr: number[])');
        expect(result.seedText).toContain('arr[i] = arr[i] * 2');
        expect(result.seedText).toContain('```\n');

        // Conclusion paragraph (含"注意"关键词) preserved
        expect(result.seedText).toContain('必须完整应用');
    });

    it('preserves keyword-important paragraphs (结论 / TL;DR / ⚠️)', async () => {
        const para = (label: string, len: number) => `${label}\n\n` + 'a'.repeat(len);
        const longAnswer = [
            para('开头分析', 500),
            para('过程描述 #1', 2000),
            para('过程描述 #2', 2000),
            para('过程描述 #3', 2000),
            '⚠️ 关键警告：必须先备份数据库再执行迁移',
            para('过程描述 #5', 2000),
            '结论：方案 B 是唯一可行的路径',
        ].join('\n\n');

        const path = await writeRollout('keywords', [
            userMessage('选哪个方案'),
            assistantFinal(longAnswer),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path, tokenBudget: 1500 });

        expect(result.seedText).toContain('关键警告：必须先备份数据库');
        expect(result.seedText).toContain('结论：方案 B');
    });

    it('keeps first and last paragraphs (intent + conclusion) and elides middle ones', async () => {
        const blocks: string[] = [];
        blocks.push('第一段：意图陈述');
        for (let i = 1; i <= 20; i++) blocks.push(`中间段 #${i}: ` + 'm'.repeat(800));
        blocks.push('最后一段：最终结论');
        const longAnswer = blocks.join('\n\n');

        const path = await writeRollout('paragraphs', [
            userMessage('讨论一下'),
            assistantFinal(longAnswer),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path, tokenBudget: 1500 });

        expect(result.seedText).toContain('第一段：意图陈述');
        expect(result.seedText).toContain('最后一段：最终结论');
        expect(result.seedText).toContain('省略');
        expect(result.seedText).toContain('段');
    });

    it('falls back to head/tail char-cut when content has no paragraph structure', async () => {
        // Single mega-paragraph with no double newlines and no code fences
        const singleParagraph = 'a'.repeat(10000);
        const path = await writeRollout('no-structure', [
            userMessage('go'),
            assistantFinal(singleParagraph),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path, tokenBudget: 1500 });

        // Char-level fallback engaged
        expect(result.seedText).toContain('中间省略');
    });

    // ─── Top 1: sensitive value redaction ──────────────────────────────

    it('redacts OpenAI/Anthropic sk- API keys from user and assistant text', async () => {
        const path = await writeRollout('redact-sk', [
            userMessage('我的 key 是 sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890'),
            assistantFinal('好的，使用 sk-ant-api03-1234567890abcdefghijklmnopqrst 这个'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.seedText).not.toContain('sk-proj-AbCd');
        expect(result.seedText).not.toContain('sk-ant-api03');
        expect(result.seedText).toContain('[REDACTED-API-KEY]');
    });

    it('redacts generic api_key/secret/password = value patterns', async () => {
        const path = await writeRollout('redact-generic', [
            userMessage('config: api_key="myverysecretvalue123" password=hunter2hunter2'),
            userMessage('export ACCESS_TOKEN=tok_live_abcdef1234567890'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.seedText).not.toContain('myverysecretvalue123');
        expect(result.seedText).not.toContain('hunter2hunter2');
        expect(result.seedText).not.toContain('tok_live_abcdef1234567890');
        expect(result.seedText).toContain('[REDACTED]');
    });

    it('redacts JWT tokens and GitHub PATs', async () => {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
        const ghpat = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
        const path = await writeRollout('redact-jwt-gh', [
            userMessage(`token: ${jwt}`),
            userMessage(`github: ${ghpat}`),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.seedText).not.toContain(jwt);
        expect(result.seedText).not.toContain(ghpat);
        expect(result.seedText).toContain('[REDACTED-JWT]');
        expect(result.seedText).toContain('[REDACTED-GH-PAT]');
    });

    it('redacts Authorization headers (Bearer/Basic)', async () => {
        const path = await writeRollout('redact-auth', [
            userMessage('curl -H "Authorization: Bearer sometoken12345abc" https://api.example.com'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.seedText).not.toContain('sometoken12345abc');
        expect(result.seedText).toContain('[REDACTED]');
    });

    // ─── Top 2: cross-bucket budget reallocation ────────────────────────

    it('reallocates surplus budget from low-demand bucket to high-demand bucket', async () => {
        // Cross-bucket reallocation is an early-region behaviour; disable
        // recent-turns reservation so the test exercises it cleanly.
        const longAnswer = 'A'.repeat(20000);
        const path = await writeRollout('budget-realloc', [
            userMessage('hi'),
            userMessage('ok'),
            assistantFinal(longAnswer),
        ]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            tokenBudget: 4000,
            recentTurnsToKeep: 0,
        });

        // assistant bucket should have received more than its base 30% ratio
        // (4000 × 4 × 0.30 = 4800 chars). With reallocation it can borrow
        // from user bucket's unused budget.
        expect(result.stats.bucketUsage.assistant).toBeGreaterThan(4800);
    });

    it('respects priority order — user gets surplus before assistant when both want more', async () => {
        const longText = 'B'.repeat(15000);
        const records: object[] = [];
        for (let i = 0; i < 5; i++) records.push(userMessage(`U${i}: ${longText}`));
        for (let i = 0; i < 5; i++) records.push(assistantFinal(`A${i}: ${longText}`));
        const path = await writeRollout('priority', records);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            tokenBudget: 4000,
            recentTurnsToKeep: 0,
        });

        // user bucket should consume meaningfully more than its 35% base
        // when both compete (35% × 16000 = 5600 chars baseline)
        expect(result.stats.bucketUsage.user).toBeGreaterThan(5600);
    });

    // ---- compacted bucket absolute cap (P1 fix) -------------------------
    // Background: codex's backend writes a `compacted` event into rollout
    // when it hits its own context red-line; the event carries an LLM
    // summary in `replacement_history`. happy-cli's heuristic seed builder
    // re-injects that summary as the `compacted` bucket, and codex
    // summarises (seed + new turns) on the next auto-rescue — including a
    // paraphrase of the prior summary. Production logs (lomur instance,
    // 2026-05-14) show monotonic growth: 939 → 1536 → 3121 → 2966 → 3411
    // → 3661 chars over 6 consecutive auto /compact rounds. Without an
    // absolute cap, the surplus pass funnels leftover budget to compacted
    // whenever post-compact user/assistant turns are sparse, compounding
    // the next thread's context pressure.
    //
    // Fix: SURPLUS_PRIORITY puts `compacted` after user/assistant/files,
    // and the loop applies COMPACTED_ABS_CAP_RATIO × charBudget on its
    // total allocation. Equivalent to LangChain
    // `ConversationSummaryBufferMemory`'s `max_token_limit` on the moving
    // summary buffer — bounds summary-of-summary recursion at a constant
    // fraction of context.

    it('compacted bucket bounded by COMPACTED_ABS_CAP_RATIO when no user/asst competition', async () => {
        // 60k-char compacted summary, no post-compact turns → user/asst/files/todos
        // wants are all 0, so without the absolute cap compacted would absorb
        // all surplus (Pass 1's 20% + Pass 2's leftover) and approach earlyBudget.
        const longSummary = 'X'.repeat(60000);
        const path = await writeRollout('compacted-only', [compacted([longSummary])]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            recentTurnsToKeep: 0,
        });

        // recompute earlyBudget the same way composeSeed does (no recent
        // block since recentTurnsToKeep=0; no trailerNote).
        const charBudget = DEFAULT_TOKEN_BUDGET * TOKEN_CHAR_RATIO;
        const fixedOverhead = SEED_SENTINEL.length
            + HEADER_OVERHEAD_RESERVE
            + DEFAULT_TRAILER.length
            + SECTION_SEPARATOR_RESERVE;
        const earlyBudget = charBudget - fixedOverhead;
        const absCap = Math.floor(earlyBudget * COMPACTED_ABS_CAP_RATIO);
        const pass1Cap = Math.floor(earlyBudget * 0.20);

        // Pass 1's 20% static cap held; Pass 2 distributed *some* surplus to
        // compacted (otherwise the absolute cap is moot to test).
        expect(result.stats.bucketUsage.compacted).toBeGreaterThan(pass1Cap);
        // But the absolute cap held — compacted did NOT swallow all leftover.
        expect(result.stats.bucketUsage.compacted).toBeLessThanOrEqual(absCap);
    });

    it('user preempts compacted surplus when both compete for leftover budget', async () => {
        // user.want > Pass 1 cap → user takes Pass 2 surplus before compacted.
        // compacted.want is huge but capped by absCap.
        const longSummary = 'X'.repeat(60000);
        const longUserText = 'U'.repeat(20000);
        const path = await writeRollout('priority-with-compacted', [
            compacted([longSummary]),
            userMessage(longUserText),
        ]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            recentTurnsToKeep: 0,
        });

        const charBudget = DEFAULT_TOKEN_BUDGET * TOKEN_CHAR_RATIO;
        const fixedOverhead = SEED_SENTINEL.length
            + HEADER_OVERHEAD_RESERVE
            + DEFAULT_TRAILER.length
            + SECTION_SEPARATOR_RESERVE;
        const earlyBudget = charBudget - fixedOverhead;
        const absCap = Math.floor(earlyBudget * COMPACTED_ABS_CAP_RATIO);
        const userPass1 = Math.floor(earlyBudget * 0.35);

        // user got surplus past its Pass 1 cap — confirms surplus order
        // visits user before compacted.
        expect(result.stats.bucketUsage.user).toBeGreaterThan(userPass1);
        // compacted still bounded by abs cap despite the high want.
        expect(result.stats.bucketUsage.compacted).toBeLessThanOrEqual(absCap);
    });

    // ─── Top 3.1: markdown table preservation ──────────────────────────

    it('preserves markdown pipe tables as atomic blocks (no row splitting)', async () => {
        const table = [
            '| 方案 | 收益 | 成本 |',
            '|------|------|------|',
            '| A    | 高   | 低   |',
            '| B    | 中   | 中   |',
            '| C    | 低   | 高   |',
        ].join('\n');
        const intro = '我对比了三种方案：\n\n';
        const filler = '\n\n' + 'x'.repeat(8000) + '\n\n';
        const conclusion = '基于上表，推荐方案 A。';
        const longAnswer = intro + table + filler + conclusion;

        const path = await writeRollout('mdtable', [
            userMessage('给个方案对比'),
            assistantFinal(longAnswer),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path, tokenBudget: 1500 });

        // Every table row must be present (table not split mid-rows)
        expect(result.seedText).toContain('| 方案 | 收益 | 成本 |');
        expect(result.seedText).toContain('| A    | 高   | 低   |');
        expect(result.seedText).toContain('| B    | 中   | 中   |');
        expect(result.seedText).toContain('| C    | 低   | 高   |');
    });

    // ─── Top 3.2: apply_patch +N/-M summary ────────────────────────────

    it('extracts +N/-M counts from apply_patch and renders alongside file paths', async () => {
        const patch = [
            '*** Begin Patch',
            '*** Update File: src/foo.ts',
            '@@',
            '+ added line 1',
            '+ added line 2',
            '+ added line 3',
            '- removed line',
            '*** Update File: src/bar.ts',
            '@@',
            '+ another added',
            '- a',
            '- b',
            '*** End Patch',
        ].join('\n');
        const path = await writeRollout('patch-summary', [
            userMessage('apply'),
            applyPatchCall(patch),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });

        expect(result.seedText).toContain('src/foo.ts (+3/-1)');
        expect(result.seedText).toContain('src/bar.ts (+1/-2)');
    });

    it('handles tool-only rollout (no user/assistant messages, only file edits)', async () => {
        const path = await writeRollout('tool-only', [
            shellCall('cat src/a.ts'),
            shellCall('cat src/b.ts'),
            shellCall('rg "foo" packages/cli/main.ts'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.stats.userTurns).toBe(0);
        expect(result.stats.fileEdits).toBeGreaterThan(0);
        expect(result.seedText).toContain('涉及的文件路径');
    });

    // ---- seed sentinel detection (compaction-loop fix) ------------------
    // Background: prior to 2026-04-25, every /compact prepended the previous
    // seed to the next user prompt as plain text, so codex persisted the
    // whole seed as a `role:user` response_item. The next /compact then read
    // that rollout and put the seed back into the `user` bucket — leading to
    // unbounded seed growth (7K → 14K → 20K …) and eventual real-content
    // truncation by the global head/tail collapse.
    //
    // Fix: every seed is now emitted with a leading SEED_SENTINEL line, and
    // the read path detects it to route the prior seed into the `compacted`
    // bucket (which is naturally bounded and discards older user history).

    it('emits SEED_SENTINEL as the first line of every produced seed', async () => {
        const path = await writeRollout('emit-sentinel', [
            userMessage('hello'),
            assistantFinal('hi'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.seedText.startsWith(SEED_SENTINEL)).toBe(true);
    });

    it('routes user message starting with SEED_SENTINEL to compacted bucket', async () => {
        const priorSeed = `${SEED_SENTINEL}\n## 上下文摘要（happy /compact 本地重建）\n\n旧对话摘要 A\n旧对话摘要 B\n`;
        const path = await writeRollout('detect-sentinel', [
            userMessage(priorSeed),
            userMessage('actual user question after compact'),
            assistantFinal('answer to that question'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.stats.hadCompactedRecord).toBe(true);
        expect(result.stats.bucketUsage.compacted).toBeGreaterThan(0);
        expect(result.seedText).toContain('actual user question');
        expect(result.seedText).toContain('旧对话摘要');
    });

    it('discards earlier (pre-sentinel) user/assistant content like processCompacted does', async () => {
        // This sequence cannot occur in real rollouts (sentinel is always the
        // first user message in a fresh thread), but exercises the discard
        // contract — same as the existing "reuses compacted record" test.
        const priorSeed = `${SEED_SENTINEL}\nseeded content`;
        const path = await writeRollout('discard-pre-sentinel', [
            userMessage('pre-seed user turn'),
            assistantFinal('pre-seed final answer'),
            userMessage(priorSeed),
            userMessage('post-sentinel turn'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.stats.userTurns).toBe(1); // only post-sentinel
        expect(result.stats.finalAnswers).toBe(0);
        expect(result.seedText).toContain('post-sentinel turn');
        expect(result.seedText).not.toContain('pre-seed user turn');
        expect(result.seedText).not.toContain('pre-seed final answer');
    });

    it('does not bloat across simulated double-compaction', async () => {
        // First compact: build seed S1 from a small conversation.
        const path1 = await writeRollout('bloat-round1', [
            userMessage('原始问题 1'),
            assistantFinal('原始回答 1'),
            userMessage('原始问题 2'),
            assistantFinal('原始回答 2'),
        ]);
        const r1 = await buildHeuristicSeed({ rolloutPath: path1 });
        const s1 = r1.seedText;

        // Second compact: simulate a new thread that began with S1 prepended
        // to the user's next question, plus one more turn.
        const path2 = await writeRollout('bloat-round2', [
            userMessage(s1),
            userMessage('新问题'),
            assistantFinal('新回答'),
        ]);
        const r2 = await buildHeuristicSeed({ rolloutPath: path2 });

        // Detection took effect: prior seed sits in compacted bucket, not user.
        expect(r2.stats.hadCompactedRecord).toBe(true);
        expect(r2.stats.bucketUsage.compacted).toBeGreaterThan(0);
        expect(r2.stats.userTurns).toBe(1); // only "新问题"

        // Without the fix, |S2| would be roughly |S1| + new content. With the
        // fix the compacted bucket is bounded by `compacted: 0.20` of total
        // budget, so S2 must not significantly exceed S1.
        expect(r2.seedText.length).toBeLessThanOrEqual(s1.length + 2000);
    });

    // ─── extraUserTexts: rollout-vs-flush race recovery ────────────────────
    //
    // Race scenario: user sends a new prompt → happy-cli pushes it into the
    // turn loop and dispatches `turn/start` → codex hasn't yet flushed the
    // message to rollout.jsonl → an auto-rescue compact fires → buildHeuristic
    // Seed scans the rollout and sees *nothing* (or stale state). The result:
    // the brand-new user prompt vanishes from the seed and the next thread
    // starts with no awareness of what the user just asked.
    //
    // Fix: caller passes the still-in-memory user message(s) via
    // `extraUserTexts`. They get spliced into the user bucket as the newest
    // entries, protected by USER_RECENT_FORCE_KEEP.

    it('extraUserTexts: recovers the new prompt when rollout is empty (race window)', async () => {
        // Pathological race: rollout file exists but is empty — codex hasn't
        // flushed anything yet for this thread.
        const path = await writeRollout('race-empty-rollout', []);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            extraUserTexts: ['用户刚提交的新任务：请帮我重构这个模块'],
        });

        expect(result.stats.userTurns).toBe(1);
        expect(result.seedText).toContain('用户刚提交的新任务');
        expect(result.seedText).toContain('请帮我重构这个模块');
    });

    it('extraUserTexts: appends as newest entries after rollout-scanned messages', async () => {
        const path = await writeRollout('race-with-history', [
            userMessage('历史消息 1'),
            assistantFinal('历史回答 1'),
            userMessage('历史消息 2'),
        ]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            extraUserTexts: ['刚发出但未刷盘的新消息'],
        });

        expect(result.stats.userTurns).toBe(3);
        expect(result.seedText).toContain('历史消息 1');
        expect(result.seedText).toContain('历史消息 2');
        expect(result.seedText).toContain('刚发出但未刷盘的新消息');

        // Newest-first force-keep means the extra message must sit AFTER
        // history in chronological order (packBucket reverses back).
        const idxOld = result.seedText.indexOf('历史消息 2');
        const idxNew = result.seedText.indexOf('刚发出但未刷盘的新消息');
        expect(idxOld).toBeGreaterThan(-1);
        expect(idxNew).toBeGreaterThan(idxOld);
    });

    it('extraUserTexts: force-keeps the new prompt even under tight budget', async () => {
        // Flood rollout with old messages that would normally swallow the budget.
        const filler = (i: number) => 'z'.repeat(2000) + ` #${i}`;
        const records: object[] = [];
        for (let i = 0; i < 30; i++) records.push(userMessage(`旧消息 ${filler(i)}`));
        const path = await writeRollout('race-budget-pressure', records);

        const result = await buildHeuristicSeed({
            rolloutPath: path,
            tokenBudget: 1000,
            extraUserTexts: ['这是关键的新任务输入'],
        });

        // USER_RECENT_FORCE_KEEP=3 means the 3 newest user texts survive
        // regardless of budget — the spliced extra is at position newest.
        expect(result.seedText).toContain('这是关键的新任务输入');
    });

    it('extraUserTexts: applies sensitive redaction', async () => {
        const path = await writeRollout('race-redact', []);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            extraUserTexts: ['请用这个 key: sk-proj-LeakedSecretAbCdEfGhIjKlMnOpQrStUvWx'],
        });
        expect(result.seedText).not.toContain('LeakedSecret');
        expect(result.seedText).toContain('[REDACTED-API-KEY]');
    });

    it('extraUserTexts: filters environment_context noise the same as rollout-sourced messages', async () => {
        const path = await writeRollout('race-noise', []);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            extraUserTexts: [
                '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>',
                '真正的用户输入',
            ],
        });
        expect(result.stats.userTurns).toBe(1);
        expect(result.seedText).toContain('真正的用户输入');
        expect(result.seedText).not.toContain('environment_context');
    });

    it('extraUserTexts: SEED_SENTINEL in extras routes to compacted bucket (no user-bucket bloat)', async () => {
        // Simulates: a prior /compact produced a seed, the user's next prompt
        // (which contains the prepended seed at its start) is the in-memory
        // turn input that hasn't flushed yet.
        const priorSeed = `${SEED_SENTINEL}\n## 上下文摘要\n- 之前讨论过 X`;
        const path = await writeRollout('race-sentinel', [
            userMessage('应被清空的早期消息'),
        ]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            extraUserTexts: [priorSeed, '基于摘要继续：新问题 Y'],
        });

        // Sentinel triggers compacted-bucket swap and clears userTexts; then
        // the post-sentinel extra ("新问题 Y") is appended.
        expect(result.stats.hadCompactedRecord).toBe(true);
        expect(result.stats.userTurns).toBe(1);
        expect(result.seedText).not.toContain('应被清空的早期消息');
        expect(result.seedText).toContain('之前讨论过 X');
        expect(result.seedText).toContain('新问题 Y');
    });

    it('extraUserTexts: empty array and undefined behave identically (no-op safety)', async () => {
        const path = await writeRollout('race-noop', [userMessage('只有这一条')]);
        const a = await buildHeuristicSeed({ rolloutPath: path });
        const b = await buildHeuristicSeed({ rolloutPath: path, extraUserTexts: [] });
        const c = await buildHeuristicSeed({ rolloutPath: path, extraUserTexts: ['', '  '.trim()] });
        // All three should produce structurally identical seeds.
        expect(b.seedText).toBe(a.seedText);
        expect(c.seedText).toBe(a.seedText);
    });

    // ─── Turn-anchored must-keep region (the "industry contract") ───────
    //
    // These tests enforce the recency guarantee: the last K conversation
    // turns are kept verbatim regardless of any other pressure. Bucket
    // budgets, the section-aware fallback, and even pathological inputs
    // must NEVER mid-cut a turn nor silently drop a turn from this region.

    it('last K turns are present verbatim in the must-keep section', async () => {
        const path = await writeRollout('recent-verbatim', [
            userMessage('turn 1 question'),
            assistantFinal('turn 1 answer'),
            userMessage('turn 2 question'),
            assistantFinal('turn 2 answer'),
            userMessage('turn 3 question'),
            assistantFinal('turn 3 answer'),
            userMessage('turn 4 question'),
            assistantFinal('turn 4 answer'),
        ]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            recentTurnsToKeep: 3,
        });
        // Recent section header present
        expect(result.seedText).toContain('### 最近 3 轮完整对话');
        // All last 3 turns present in full
        for (const i of [2, 3, 4]) {
            expect(result.seedText).toContain(`turn ${i} question`);
            expect(result.seedText).toContain(`turn ${i} answer`);
        }
        // user/assistant rendered with role labels in the recent block
        expect(result.seedText).toContain('**用户**: turn 4 question');
        expect(result.seedText).toContain('**我**: turn 4 answer');
        // Stats reflect the split
        expect(result.stats.recentTurnsCount).toBe(3);
        expect(result.stats.earlyTurnsCount).toBe(1);
        expect(result.stats.recentTurnsChars).toBeGreaterThan(0);
        // recentBlock is exposed at the top level so the L2 pipeline can
        // re-append it verbatim after the LLM narrative replaces seedText.
        // It must contain the verbatim recent turns AND the must-keep heading.
        expect(result.recentBlock).toContain('### 最近 3 轮完整对话');
        expect(result.recentBlock).toContain('**用户**: turn 4 question');
        expect(result.recentBlock).toContain('**我**: turn 4 answer');
        // The recentBlock must be a substring of seedText (i.e. exactly what
        // the heuristic embedded into its own seed — so re-appending it
        // after an L2 narrative reproduces the must-keep contract bit-for-bit).
        expect(result.seedText).toContain(result.recentBlock);
    });

    it('recentBlock is empty when caller disables must-keep (recentTurnsToKeep=0)', async () => {
        const path = await writeRollout('recent-block-empty', [
            userMessage('only turn'),
            assistantFinal('only reply'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path, recentTurnsToKeep: 0 });
        expect(result.recentBlock).toBe('');
        expect(result.stats.recentTurnsCount).toBe(0);
        // seedText must still produce a usable seed (heading + bucket content)
        expect(result.seedText).toContain('## 上下文摘要');
    });

    it('user and assistant are paired within a turn (no cross-turn drift)', async () => {
        // Verify that turn N's assistant appears AFTER turn N's user but
        // BEFORE turn N+1's user — proves the turn boundary identification works.
        const path = await writeRollout('pairing', [
            userMessage('Q-A'),
            assistantFinal('R-A'),
            userMessage('Q-B'),
            assistantFinal('R-B'),
        ]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            recentTurnsToKeep: 2,
        });
        const idxQA = result.seedText.indexOf('Q-A');
        const idxRA = result.seedText.indexOf('R-A');
        const idxQB = result.seedText.indexOf('Q-B');
        const idxRB = result.seedText.indexOf('R-B');
        // All four found, in chronological order with correct pairing
        for (const idx of [idxQA, idxRA, idxQB, idxRB]) expect(idx).toBeGreaterThan(-1);
        expect(idxQA).toBeLessThan(idxRA);
        expect(idxRA).toBeLessThan(idxQB);
        expect(idxQB).toBeLessThan(idxRB);
    });

    it('a turn with no final_answer (mid-response /compact) is annotated', async () => {
        // Simulate happy auto-rescue firing after user prompt but before
        // codex's response — the last turn has user but no assistant.
        const path = await writeRollout('incomplete-turn', [
            userMessage('completed Q'),
            assistantFinal('completed A'),
            userMessage('pending Q'),
            // no assistant message — turn was interrupted
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.seedText).toContain('pending Q');
        expect(result.seedText).toContain('回答未完成');
        expect(result.stats.finalAnswers).toBe(1); // only "completed A" had a final_answer
    });

    it('force-keep guarantee under budget pressure — last 3 turns survive even with 50 noise turns', async () => {
        // 50 large bogus turns + 3 small distinct recent turns + small budget.
        // Old algorithm would slice into the recent turns via head/tail cut.
        // New algorithm drops early sections whole; recent turns untouched.
        const filler = 'F'.repeat(2000);
        const records: object[] = [];
        for (let i = 0; i < 50; i++) {
            records.push(userMessage(`noise ${i} ${filler}`));
            records.push(assistantFinal(`noise ans ${i} ${filler}`));
        }
        records.push(userMessage('CRITICAL_A'));
        records.push(assistantFinal('CRITICAL_A_REPLY'));
        records.push(userMessage('CRITICAL_B'));
        records.push(assistantFinal('CRITICAL_B_REPLY'));
        records.push(userMessage('CRITICAL_C'));
        records.push(assistantFinal('CRITICAL_C_REPLY'));
        const path = await writeRollout('force-keep-budget', records);

        const result = await buildHeuristicSeed({
            rolloutPath: path,
            tokenBudget: 1000,
            recentTurnsToKeep: 3,
        });
        for (const tag of ['CRITICAL_A', 'CRITICAL_A_REPLY', 'CRITICAL_B', 'CRITICAL_B_REPLY', 'CRITICAL_C', 'CRITICAL_C_REPLY']) {
            expect(result.seedText, `must-keep contract: ${tag}`).toContain(tag);
        }
        // Recent block stays at the requested size, untouched by budget pressure.
        expect(result.stats.recentTurnsCount).toBe(3);
        // Seed stays within budget (small slack for headers/separators).
        expect(result.seedText.length).toBeLessThanOrEqual(1000 * 4 + 600);
    });

    it('recent region itself overflowing the budget: drops oldest turn whole, never mid-cut', async () => {
        // 3 turns × ~6 KB each = ~18 KB recent block, with budget=2000 (8 KB).
        // shrinkRecentRegion should drop the oldest turn until the rest fits;
        // it must NEVER produce a string mid-cut from one of the surviving turns.
        const big = (label: string) => label + ' '.repeat(4000) + label + '_end';
        const path = await writeRollout('recent-overflow', [
            userMessage(big('Q_OLDEST')),
            assistantFinal(big('A_OLDEST')),
            userMessage(big('Q_MID')),
            assistantFinal(big('A_MID')),
            userMessage(big('Q_NEWEST')),
            assistantFinal(big('A_NEWEST')),
        ]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            tokenBudget: 2000,
            recentTurnsToKeep: 3,
        });
        // Newest turn definitely survives in full (both start and end markers)
        expect(result.seedText).toContain('Q_NEWEST');
        expect(result.seedText).toContain('Q_NEWEST_end');
        expect(result.seedText).toContain('A_NEWEST');
        expect(result.seedText).toContain('A_NEWEST_end');
        // shrink warning surfaces
        expect(result.stats.droppedSections.some(s => s.startsWith('recent-shrunk'))).toBe(true);
    });

    it('shrinkRecentRegion single-turn fallback still renders per-turn fileEdits', async () => {
        // Forces the single-turn smartTruncate path (3 huge turns + tiny
        // budget) AND ensures the surviving turn has fileEdits — verifies
        // R2-1 contract: the **涉及文件** line stays symmetric with the
        // normal renderRecentTurns path even in the shrink fallback.
        const big = (label: string) => label + ' '.repeat(4000) + label + '_end';
        const path = await writeRollout('shrink-with-files', [
            userMessage(big('Q_OLDEST')),
            assistantFinal(big('A_OLDEST')),
            userMessage(big('Q_MID')),
            assistantFinal(big('A_MID')),
            userMessage(big('Q_NEWEST_with_files')),
            shellCall('cat src/touched.ts'),
            applyPatchCall('*** Update File: src/patched.ts\n+ line\n'),
            assistantFinal(big('A_NEWEST_with_files')),
        ]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            tokenBudget: 2000,
            recentTurnsToKeep: 3,
        });
        // Newest turn body survives (smartTruncate keeps head + tail markers)
        expect(result.seedText).toContain('Q_NEWEST_with_files');
        expect(result.seedText).toContain('A_NEWEST_with_files');
        // Per-turn file context survives the shrink path
        expect(result.seedText).toMatch(/\*\*涉及文件\*\*:.*src\/touched\.ts/);
        expect(result.seedText).toMatch(/\*\*涉及文件\*\*:.*src\/patched\.ts/);
        expect(result.stats.droppedSections.some(s => s.startsWith('recent-shrunk'))).toBe(true);
    });

    it('K = 0 disables must-keep region — entire conversation is summarisable', async () => {
        const path = await writeRollout('k-zero', [
            userMessage('hello'),
            assistantFinal('world'),
            userMessage('again'),
            assistantFinal('done'),
        ]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            recentTurnsToKeep: 0,
        });
        // No must-keep block — only the early buckets
        expect(result.seedText).not.toContain('最近 0 轮');
        expect(result.seedText).not.toContain('最近 1 轮');
        expect(result.stats.recentTurnsCount).toBe(0);
        expect(result.stats.earlyTurnsCount).toBe(2);
        // Content still surfaces through the early bucket
        expect(result.seedText).toContain('hello');
        expect(result.seedText).toContain('done');
    });

    it('extras land in the must-keep region as their own turns', async () => {
        // 1 rollout turn + 2 extras → 3 total turns. With K=3 all should
        // be in the recent block, each as its own annotated turn.
        const path = await writeRollout('extras-as-turns', [
            userMessage('rollout turn 1'),
            assistantFinal('rollout reply 1'),
        ]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            recentTurnsToKeep: 3,
            extraUserTexts: ['in-flight prompt A', 'in-flight prompt B'],
        });
        expect(result.stats.recentTurnsCount).toBe(3);
        // Rollout turn has its assistant — completed
        expect(result.seedText).toContain('**用户**: rollout turn 1');
        expect(result.seedText).toContain('**我**: rollout reply 1');
        // Extras are turns without final_answer — annotated as such
        expect(result.seedText).toContain('**用户**: in-flight prompt A');
        expect(result.seedText).toContain('**用户**: in-flight prompt B');
        expect(result.seedText).toContain('回答未完成');
        // Ordering: rollout turn first, then extras in given order
        const ord = ['rollout turn 1', 'in-flight prompt A', 'in-flight prompt B'].map(s => result.seedText.indexOf(s));
        expect(ord[0]).toBeLessThan(ord[1]);
        expect(ord[1]).toBeLessThan(ord[2]);
    });

    it('per-turn file edits surface in the recent block (turn-anchored file context)', async () => {
        // Recent turn touches src/a.ts and src/b.ts via shell, then patches
        // src/c.ts. The recent block should label this turn with all three
        // paths under `**涉及文件**:`. Files outside the recent block still
        // appear in the cross-turn `### 涉及的文件路径` aggregate.
        const path = await writeRollout('per-turn-files', [
            userMessage('early Q'),
            shellCall('cat src/old.ts'),
            assistantFinal('early A'),
            userMessage('recent Q: please fix the bug'),
            shellCall('cat src/a.ts src/b.ts'),
            applyPatchCall('*** Update File: src/c.ts\n+ new line\n'),
            assistantFinal('recent A'),
        ]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            recentTurnsToKeep: 1,
        });
        // The recent turn has its files surfaced inline
        expect(result.seedText).toMatch(/\*\*涉及文件\*\*:.*src\/a\.ts/);
        expect(result.seedText).toMatch(/\*\*涉及文件\*\*:.*src\/b\.ts/);
        expect(result.seedText).toMatch(/\*\*涉及文件\*\*:.*src\/c\.ts/);
        // The pre-recent file `src/old.ts` should NOT be in the per-turn line
        // of the recent turn (it can only appear in the global files section).
        const recentBlockStart = result.seedText.indexOf('### 最近 1 轮');
        const recentBlock = result.seedText.slice(recentBlockStart);
        expect(recentBlock).not.toContain('src/old.ts');
    });

    it('per-turn file edits omit the line when no files were touched', async () => {
        // Pure chat turn — no shell, no apply_patch. The `**涉及文件**:` line
        // must not render (no empty stub), and the global files section must
        // also be absent (no edits anywhere).
        const path = await writeRollout('per-turn-files-empty', [
            userMessage('just chatting'),
            assistantFinal('just answering'),
        ]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            recentTurnsToKeep: 1,
        });
        expect(result.seedText).not.toContain('**涉及文件**');
        expect(result.seedText).not.toContain('### 涉及的文件路径');
    });

    it('per-turn file edits de-duplicate within a turn (shell + patch on same path)', async () => {
        // shell mentions src/x.ts, then apply_patch updates the same file —
        // de-dupe so the line says "src/x.ts" once, not twice.
        const path = await writeRollout('per-turn-files-dedupe', [
            userMessage('update x.ts'),
            shellCall('cat src/x.ts'),
            applyPatchCall('*** Update File: src/x.ts\n+ added\n'),
            assistantFinal('done'),
        ]);
        const result = await buildHeuristicSeed({
            rolloutPath: path,
            recentTurnsToKeep: 1,
        });
        const recentBlockStart = result.seedText.indexOf('### 最近 1 轮');
        const recentBlock = result.seedText.slice(recentBlockStart);
        // Count occurrences of src/x.ts inside the **涉及文件** line only
        const filesLineMatch = recentBlock.match(/\*\*涉及文件\*\*: ([^\n]+)/);
        expect(filesLineMatch).not.toBeNull();
        if (!filesLineMatch) return;
        const occurrences = (filesLineMatch[1].match(/src\/x\.ts/g) ?? []).length;
        expect(occurrences).toBe(1);
    });

    it('commentary inside a turn is dropped; only final_answer enters assistant block', async () => {
        // commentary is codex's thinking-aloud — must not leak into the seed
        // since it provides no value to the next thread.
        const path = await writeRollout('commentary-drop', [
            userMessage('Q'),
            assistantCommentary('let me think aloud about Q...'),
            assistantFinal('actual answer to Q'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.seedText).toContain('actual answer to Q');
        expect(result.seedText).not.toContain('let me think aloud');
    });

    it('SEED_SENTINEL in rollout clears all prior turns (sentinel-anchored discard)', async () => {
        // Verifies the post-refactor sentinel routing still works: any user
        // message starting with sentinel collapses prior history into
        // lastCompacted, so the seed bloat loop is still broken.
        const path = await writeRollout('sentinel-clear', [
            userMessage('pre-sentinel turn 1'),
            assistantFinal('pre-sentinel reply 1'),
            userMessage('pre-sentinel turn 2'),
            assistantFinal('pre-sentinel reply 2'),
            userMessage(`${SEED_SENTINEL}\n## prior compact summary`),
            userMessage('post-sentinel question'),
            assistantFinal('post-sentinel reply'),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
        expect(result.stats.hadCompactedRecord).toBe(true);
        // Everything before sentinel must be gone from the recent/early regions
        expect(result.seedText).not.toContain('pre-sentinel turn 1');
        expect(result.seedText).not.toContain('pre-sentinel turn 2');
        expect(result.seedText).not.toContain('pre-sentinel reply 1');
        // Post-sentinel content survives
        expect(result.seedText).toContain('post-sentinel question');
        expect(result.seedText).toContain('post-sentinel reply');
        // Sentinel payload is in the compacted bucket
        expect(result.seedText).toContain('prior compact summary');
    });
});
