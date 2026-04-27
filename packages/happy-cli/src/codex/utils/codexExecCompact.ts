/**
 * LLM-driven /compact via a fresh, ephemeral `codex exec` process (Step 2).
 *
 * Pipeline:
 *   buildHeuristicSeed (Step 1, fast deterministic filter ~22 ms on a 5.75 MB
 *     rollout, caps output at DEFAULT_TOKEN_BUDGET ≈ 12 K tokens)
 *   → compactViaCodexExec (this module, LLM narrative summary)
 *   → final seedText injected on the next turn
 *
 * Why a separate process instead of asking the live thread to summarise?
 *   The live thread is exactly the one that overflowed; piling another
 *   "summarise yourself" turn on top hits the same context limit. A fresh
 *   `codex exec` runs in a brand-new context window, so the heuristic
 *   pre-filter (≤ 12 K tokens) always fits with room to spare.
 *
 * Empirically tuned (real 5.75 MB rollout, 2026-04-25):
 *   gpt-5.4-mini + model_reasoning_effort="none" + web_search="disabled"
 *     stable network: 12-25 s
 *     bad network:    60-120 s (codex CLI auto-retries 5 ×; we don't add an
 *                     outer retry layer — single-call retries are enough)
 *   Token usage:      ~15 K / call (heuristic seed + ~12 K codex baseline)
 *   Output:           ~3 KB narrative summary covering intent / files /
 *                     conclusions, dramatically richer than the heuristic
 *                     bullet extraction.
 *
 * Caller contract:
 *   - On `summary !== null`, wrap with `wrapL2SeedAsHeuristicSeed` and use
 *     as the new seed.
 *   - On `summary === null`, fall back to the heuristic seed (already
 *     available — the caller passed it in).
 *   - The `skipped: 'short_circuit'` case means the heuristic seed is
 *     already short enough that paying the L2 fixed token cost is wasteful;
 *     the caller should also use the heuristic seed unchanged.
 *
 * Config-key footnotes (took 30 min to nail down, save the next person):
 *   - `gpt-5.4-mini` rejects `model_reasoning_effort="minimal"`. Supported
 *     values are `none / low / medium / high / xhigh`. `none` is fastest.
 *   - `web_search` is a top-level config field that accepts `disabled /
 *     cached / live`. Without `web_search="disabled"`, effort=none fails
 *     because the API rules forbid web_search at low/none effort.
 *   - `--disable web_search` flag form does NOT work (codex CLI quirk);
 *     must use `-c web_search="disabled"`.
 */

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import { buildWindowsSpawnArgs } from '../codexAppServerClient';
import { SEED_SENTINEL } from './compactSeedBuilder';

export type CodexReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export interface CodexExecCompactOptions {
    /** Already-filtered heuristic seed (Step 1 output). */
    heuristicSeed: string;
    /**
     * CODEX_HOME for auth profile, e.g. ~/.happy/auth/codex/instances/xie2.
     * Falls back to the current process env when omitted.
     */
    codexHome?: string;
    /** Hard timeout in ms (default 120 s — covers worst-case codex retries). */
    timeoutMs?: number;
    /** Codex model slug (default `gpt-5.4-mini`). */
    model?: string;
    /**
     * Reasoning effort. `none` is the fastest archetype that still produces
     * a coherent summary; higher levels add latency without measurable
     * quality gain on summarisation tasks.
     */
    reasoningEffort?: CodexReasoningEffort;
    /** Override the codex executable path (used by tests). */
    codexBin?: string;
}

export interface CodexExecCompactResult {
    /** LLM-generated summary, or null on failure / short-circuit. */
    summary: string | null;
    /** Wall-clock duration in ms. */
    elapsedMs: number;
    /** Reason for failure when summary is null. */
    error?: string;
    /**
     * `'short_circuit'` when the heuristic seed was already below
     * MIN_SEED_CHARS_FOR_LLM and the spawn was skipped — the caller should
     * use the heuristic seed unchanged.
     */
    skipped?: 'short_circuit';
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_EFFORT: CodexReasoningEffort = 'none';
/**
 * Below this threshold, the heuristic seed itself is small enough that
 * paying the ~12 K baseline token cost of `codex exec` is wasteful. Roughly
 * a session with fewer than ~5 user turns or ~2 KB of dialog content. The
 * number is a cost/benefit knob, not a correctness one.
 */
const MIN_SEED_CHARS_FOR_LLM = 1500;
/** Output shorter than this is almost certainly a model refusal/error. */
const MIN_OUTPUT_CHARS = 100;

function buildSummarizationPrompt(seed: string): string {
    return `请把以下对话摘要重新组织为一份连贯的中文叙事摘要。要求：
1. 覆盖：用户核心意图与决策路径、已浏览/修改/分析的关键文件与函数、你给出的关键结论或建议
2. ≤1500 字，自然语言叙事，不要 bullet 罗列
3. 直接输出摘要正文，不要前导寒暄、不要"好的"之类开场白

对话原文：
${seed}`;
}

/**
 * Spawn a fresh `codex exec` process to produce an LLM summary of the
 * already-filtered heuristic seed. Never throws — every failure path is
 * folded into `result.error` so the caller can transparently fall back.
 */
export async function compactViaCodexExec(
    opts: CodexExecCompactOptions,
): Promise<CodexExecCompactResult> {
    const startMs = Date.now();
    const seedLen = opts.heuristicSeed.length;

    if (seedLen < MIN_SEED_CHARS_FOR_LLM) {
        return {
            summary: null,
            elapsedMs: Date.now() - startMs,
            skipped: 'short_circuit',
            error: `seed length ${seedLen} < threshold ${MIN_SEED_CHARS_FOR_LLM}`,
        };
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const outFile = join(tmpdir(), `happy-l2-out-${randomUUID()}.txt`);
    const codexBin = opts.codexBin ?? 'codex';

    const args = [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '-s', 'read-only',
        '-m', opts.model ?? DEFAULT_MODEL,
        '-c', `model_reasoning_effort="${opts.reasoningEffort ?? DEFAULT_EFFORT}"`,
        '-c', 'web_search="disabled"',
        '-o', outFile,
        '-',
    ];

    const env = { ...process.env };
    if (opts.codexHome) env.CODEX_HOME = opts.codexHome;

    // Windows: codex is installed as `codex.cmd` shim. Direct spawn breaks on
    // args containing TOML quotes (`web_search="disabled"`) — the cmd.exe
    // shim swallows the inner quotes. buildWindowsSpawnArgs wraps with
    // `cmd.exe /d /s /c` + escapeCmdArgument + windowsVerbatimArguments to
    // pass args verbatim. No-op on macOS/Linux. (See happy-cli CLAUDE.md
    // "Windows .cmd shim spawn" gotcha.)
    const winSpawn = buildWindowsSpawnArgs(codexBin, args);

    const stderrChunks: Buffer[] = [];
    let killReason: 'timeout' | null = null;

    let child: ReturnType<typeof spawn>;
    try {
        child = spawn(winSpawn.spawnCommand, winSpawn.spawnArgs, {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsVerbatimArguments: winSpawn.windowsVerbatimArguments,
            // Without this, `cmd.exe /d /s /c codex ...` flashes a black
            // console window on every /compact (cf. AcpBackend.ts:396).
            windowsHide: true,
        });
    } catch (err) {
        const elapsedMs = Date.now() - startMs;
        const msg = `spawn failed: ${(err as Error).message}`;
        logger.debug(`[codexExecCompact] ${msg} (${elapsedMs}ms)`);
        return { summary: null, elapsedMs, error: msg };
    }

    // stdio: ['pipe', 'pipe', 'pipe'] guarantees these streams exist, but the
    // ChildProcess type signature reports them nullable. Assert here so we
    // get clean access without `!` noise sprinkled through the rest of the
    // function.
    const childStdin = child.stdin;
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (!childStdin || !childStdout || !childStderr) {
        const elapsedMs = Date.now() - startMs;
        const msg = 'codex exec spawn returned null stdio handles';
        logger.debug(`[codexExecCompact] ${msg} (${elapsedMs}ms)`);
        return { summary: null, elapsedMs, error: msg };
    }

    // The child may exit before stdin drains (e.g. spawn ENOENT, instant
    // config parse error). Swallow EPIPE so we surface the real exit/error.
    childStdin.on('error', () => { /* intentional */ });

    // Stream prompt with backpressure handling. The heuristic Step-1 budget
    // is 12K tokens (~48 KB chars), plus the prompt template — easily
    // exceeding Linux PIPE_BUF (16 KB) and even the default 64 KB pipe
    // buffer in some kernels. A blind .end(buf) blocks the event loop until
    // the child reads, but the child has multi-second startup (auth
    // handshake, websocket connect) — classic deadlock. Streaming with
    // 'drain' lets us cooperate with the OS pipe scheduler.
    const promptText = buildSummarizationPrompt(opts.heuristicSeed);
    const promptBuf = Buffer.from(promptText, 'utf-8');
    const writePrompt = (): Promise<void> => new Promise((resolve, reject) => {
        let offset = 0;
        const CHUNK = 16 * 1024; // safely below typical pipe buffer
        const writeNext = () => {
            while (offset < promptBuf.length) {
                const slice = promptBuf.subarray(offset, offset + CHUNK);
                const ok = childStdin.write(slice);
                offset += slice.length;
                if (!ok) {
                    childStdin.once('drain', writeNext);
                    return;
                }
            }
            childStdin.end(resolve);
        };
        childStdin.once('error', reject);
        writeNext();
    });
    // Fire-and-forget: failure here is logged but not fatal — the child's
    // exit code / stderr is the real signal. Catch-and-swallow keeps the
    // outer await on `child.exit` as the single source of truth.
    writePrompt().catch((err) => {
        logger.debug(`[codexExecCompact] stdin write error (will surface via exit code): ${(err as Error).message}`);
    });

    // Drain stdout — codex CLI prints diagnostic banners we don't need (the
    // final answer is written via -o file). Not draining causes stalls.
    childStdout.on('data', () => { /* drained */ });
    childStderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
        if (stderrChunks.length > 200) stderrChunks.shift();
    });

    const timer = setTimeout(() => {
        killReason = 'timeout';
        child.kill('SIGTERM');
        // Force kill after a short grace period if SIGTERM is ignored.
        setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL');
        }, 2000).unref();
    }, timeoutMs);

    const exitCode = await new Promise<number | null>((resolve) => {
        let settled = false;
        const settle = (code: number | null) => {
            if (settled) return;
            settled = true;
            resolve(code);
        };
        child.once('exit', (code) => settle(code));
        child.once('error', () => settle(null));
    });
    clearTimeout(timer);

    const elapsedMs = Date.now() - startMs;
    const stderrTail = Buffer.concat(stderrChunks).toString('utf-8').slice(-600);

    if (killReason === 'timeout') {
        await fsp.unlink(outFile).catch(() => { /* file may not exist */ });
        const msg = `timed out after ${timeoutMs}ms`;
        logger.debug(`[codexExecCompact] ${msg}; stderr tail: ${stderrTail}`);
        return { summary: null, elapsedMs, error: msg };
    }

    if (exitCode !== 0) {
        await fsp.unlink(outFile).catch(() => { /* file may not exist */ });
        const msg = `codex exec exited ${exitCode ?? 'spawn-failed'}; stderr tail: ${stderrTail}`;
        logger.debug(`[codexExecCompact] ${msg} (${elapsedMs}ms)`);
        return { summary: null, elapsedMs, error: msg };
    }

    let raw: string;
    try {
        raw = await fsp.readFile(outFile, 'utf-8');
    } catch (err) {
        const msg = `output file not written: ${(err as Error).message}; stderr tail: ${stderrTail}`;
        logger.debug(`[codexExecCompact] ${msg} (${elapsedMs}ms)`);
        return { summary: null, elapsedMs, error: msg };
    } finally {
        await fsp.unlink(outFile).catch(() => { /* best-effort cleanup */ });
    }

    const summary = raw.trim();
    if (summary.length < MIN_OUTPUT_CHARS) {
        const msg = `output too short (${summary.length} chars), likely model refusal: ${summary}`;
        logger.debug(`[codexExecCompact] ${msg} (${elapsedMs}ms)`);
        return { summary: null, elapsedMs, error: msg };
    }

    logger.debug(
        `[codexExecCompact] L2 ok: ${elapsedMs}ms, in=${seedLen} chars, out=${summary.length} chars`,
    );
    return { summary, elapsedMs };
}

/**
 * Render a user-visible status message describing the outcome of a single
 * `/compact` call. Pure function — no IO, no globals, fully testable.
 *
 * Three cases mirror the three `CodexExecCompactResult` shapes:
 *   - `summary !== null` → emit the raw LLM narrative as-is. This is what
 *     the user sees in their chat (cf. Claude Code's `claudeRemote.ts`
 *     where the SDK streams the assistant's compaction summary as a normal
 *     chat message between the protocol "Compaction started/completed"
 *     events).
 *   - `skipped === 'short_circuit'` → conversation was below the L2 cost
 *     threshold; mention "对话较短" so the user understands why no LLM
 *     summary appeared.
 *   - any other failure → the L2 call itself failed (timeout, network,
 *     auth, missing binary). Mention "LLM 摘要不可用" so the user knows the
 *     compaction still happened (heuristic seed is in place) but is just
 *     less rich than usual.
 *
 * `fallbackSeedChars` is the size of the heuristic seed that was actually
 * injected into the next thread — matching what the user would see if they
 * inspected the rollout. Caller passes `seedText.length` after any
 * wrapping, so for L2 success this argument is unused (we return the raw
 * summary) and we don't need to special-case it on the caller side.
 */
export function renderCompactionResultMessage(
    l2: CodexExecCompactResult,
    fallbackSeedChars: number,
): string {
    // Truthy check (not `!== null`) to match the caller's seed-text update
    // branch in `runCodexAppServer.ts` /compact: an empty-string summary
    // should be treated as "L2 produced nothing useful" → fall through to
    // the heuristic-fallback message, not surface as an empty chat bubble.
    // Defensive: `compactViaCodexExec` already guards via MIN_OUTPUT_CHARS,
    // but pinning the contract here keeps both callsites in lock-step.
    if (l2.summary) return l2.summary;
    if (l2.skipped === 'short_circuit') {
        return `已使用本地启发式摘要（对话较短，${fallbackSeedChars} 字）。`;
    }
    return `LLM 摘要不可用，已使用本地启发式摘要（${fallbackSeedChars} 字）。`;
}

/**
 * Wrap a raw LLM summary into the seed envelope the rest of the pipeline
 * expects: leading SEED_SENTINEL (so the next /compact recognises it as an
 * injected seed and routes it to the compacted bucket), a heading, the
 * summary body, and the standard "summary may be lossy" trailer.
 */
export function wrapL2SeedAsHeuristicSeed(summary: string, trailerNote?: string): string {
    const trailer = [
        '---',
        '注意：以上摘要由 happy /compact + LLM 生成，可能不完整。',
        '若用户问及的内容不在摘要中，请勿假设"未讨论过" — 应当反问澄清或主动承认信息缺失。',
    ].join('\n');
    const parts: string[] = [
        SEED_SENTINEL,
        '## 上下文摘要（happy /compact LLM 重建）',
        '',
        summary,
        '',
        trailer,
    ];
    if (trailerNote) {
        parts.push('', trailerNote);
    }
    return parts.join('\n');
}
