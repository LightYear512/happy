import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHeuristicSeed } from './compactSeedBuilder';

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

    it('truncates seed when total exceeds token budget', async () => {
        const longText = 'x'.repeat(2000);
        const records: object[] = [];
        for (let i = 0; i < 50; i++) records.push(userMessage(`user ${i}: ${longText}`));
        const path = await writeRollout('overflow', records);

        const small = await buildHeuristicSeed({ rolloutPath: path, tokenBudget: 1000 });
        expect(small.seedText.length).toBeLessThanOrEqual(1000 * 4 + 200); // budget + collapse marker
        expect(small.seedText).toContain('省略中间内容');
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
        const path = await writeRollout('usage', [
            userMessage('hello'),
            assistantFinal('world'),
            shellCall('ls src/foo.ts'),
            todoCall([{ id: 1, content: 'a', status: 'in_progress' }]),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path });
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
        // Tiny user messages (low demand) + long assistant answer (high demand).
        // Old static-cap algorithm would have wasted user-bucket surplus.
        const longAnswer = 'A'.repeat(20000);
        const path = await writeRollout('budget-realloc', [
            userMessage('hi'),
            userMessage('ok'),
            assistantFinal(longAnswer),
        ]);
        const result = await buildHeuristicSeed({ rolloutPath: path, tokenBudget: 4000 });

        // assistant bucket should have received more than its base 30% ratio
        // (4000 × 4 × 0.30 = 4800 chars). With reallocation it can borrow
        // from user bucket's unused budget.
        expect(result.stats.bucketUsage.assistant).toBeGreaterThan(4800);
    });

    it('respects priority order — user gets surplus before assistant when both want more', async () => {
        // Both buckets want way more than their ratio cap; user should win.
        const longText = 'B'.repeat(15000);
        const records: object[] = [];
        for (let i = 0; i < 5; i++) records.push(userMessage(`U${i}: ${longText}`));
        for (let i = 0; i < 5; i++) records.push(assistantFinal(`A${i}: ${longText}`));
        const path = await writeRollout('priority', records);
        const result = await buildHeuristicSeed({ rolloutPath: path, tokenBudget: 4000 });

        // user bucket should consume meaningfully more than its 35% base
        // when both compete (35% × 16000 = 5600 chars baseline)
        expect(result.stats.bucketUsage.user).toBeGreaterThan(5600);
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
});
