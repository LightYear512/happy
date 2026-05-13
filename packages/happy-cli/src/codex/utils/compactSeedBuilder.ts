/**
 * Heuristic compaction seed builder.
 *
 * Given a codex rollout jsonl file, produce a compact text "seed" that fits
 * into the configured token budget and preserves load-bearing context for a
 * fresh codex conversation. Pure local CPU/IO; no LLM or network involved.
 *
 * Algorithm — turn-anchored must-keep + section-aware fallback:
 *
 *  1. Stream the rollout. Each `user` message opens a new Turn; subsequent
 *     `assistant final_answer` messages and `function_call` tool invocations
 *     attach to the current Turn until the next user message. A `compacted`
 *     record or a SEED_SENTINEL user message discards all prior Turns and
 *     installs the payload as `lastCompacted`.
 *
 *  2. Splice in-memory extras (from `extraUserTexts`) as additional Turns at
 *     the end, marked `hasFinalAnswer = false`. These are prompts that
 *     reached happy but had not yet flushed to rollout.jsonl.
 *
 *  3. Split `allTurns` into:
 *      - `recentTurns`  : the last K turns (K = recentTurnsToKeep, default 3)
 *      - `earlyTurns`   : everything before that
 *     `recentTurns` is the MUST-KEEP region — its contents are rendered
 *     verbatim with role labels (`**用户**:` / `**我**:`) and per-turn file
 *     context, and are NEVER cut by bucket budgets or the fallback.
 *
 *  4. Bucket-summarise `earlyTurns` and the global aggregates (compacted /
 *     fileEdits / todos) into the SUMMARISED region. The bucket budget is
 *     `charBudget − recentRegionSize − fixedOverhead`. Each bucket gets a
 *     ratio share with priority-based surplus redistribution.
 *
 *  5. Section-aware fallback: if the assembled seed still exceeds budget,
 *     drop early-region sections in priority order
 *     (todos → files → early-assistant → early-user → compacted). The
 *     must-keep recent block and the trailer are never touched.
 *
 *  6. Extreme overflow (must-keep itself exceeds budget): shrinkRecentRegion
 *     drops oldest turns whole — message-boundary integrity is the industry
 *     contract (Claude Code /compact, ChatGPT memory truncation, codex's own
 *     `compacted.replacement_history`: none ever mid-cut a message). If a
 *     single newest turn still overflows, fall through to smartTruncate on
 *     its body with an explicit warning annotation.
 *
 *  7. Always-on safety trailer warns the next session that the seed may be
 *     incomplete (prevents "false amnesia" — model claiming "we never
 *     discussed X" when the discussion is simply outside the seed).
 *
 * Rationale: 80%+ of rollout volume is tool stdout (function_call_output)
 * and encrypted reasoning, both useless to a new conversation. The previous
 * static per-message char caps (400/300) were catastrophic for engineering
 * sessions where a single assistant answer can run 5-10k chars. The
 * turn-anchored model adds a recency guarantee on top: regardless of how
 * the bucket math turns out, the user's most recent K turns survive intact.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { logger } from '@/ui/logger';

const TOKEN_CHAR_RATIO = 4; // rough ascii heuristic; codex sessions skew JSON/code
const DEFAULT_TOKEN_BUDGET = 12000; // ~4.7% of a 256k context window
const MAX_FILE_PATHS = 50;

/**
 * Sentinel marker emitted as the first line of every seed produced by this
 * module (and by codexExecCompact.ts wrapping the LLM summary).
 *
 * On the next /compact, when the seed-builder reads the new thread's rollout
 * and finds a user-message that starts with this sentinel, it routes the
 * whole message into the `compacted` bucket and clears `userTexts` /
 * `finalAnswers` — same as `processCompacted`. Without this, every previous
 * seed accumulates as ordinary user content (~7K → 14K → 20K…) until the
 * 48K-char global cap kicks in and head/tail-truncates real user history
 * (investigated 2026-04-25 against rollout-019dc4b9-...jsonl).
 *
 * HTML comment chosen to be: (a) invisible to markdown renderers so it
 * doesn't pollute the visible summary, (b) extremely unlikely to appear at
 * the start of a real user message.
 */
export const SEED_SENTINEL = '<!--HAPPY-COMPACT-SEED-v1-->';

// How many of the most recent conversation TURNS are kept verbatim and
// unconditionally — neither bucket budgets nor the global fallback may touch
// them. A turn = one user message + all assistant outputs / tool calls that
// followed before the next user message. This is the industry-standard
// recency guarantee (Claude Code, ChatGPT memory, codex's own backend
// compaction all do "recent K turns verbatim + earlier summarised").
const DEFAULT_RECENT_TURNS_TO_KEEP = 3;

// Per-bucket share of the *early* budget (= charBudget − reserved-for-recent
// − fixed overhead). Ratios sum to ≤1.0; the slack covers section headers
// and separators. Buckets only describe the "early" / summarised half — the
// recent-turns block is reserved independently before this allocation runs.
const BUCKET_RATIOS = {
    compacted: 0.20,
    user: 0.35,
    assistant: 0.30,
    files: 0.08,
    todos: 0.05,
} as const;

// Empirical reserve for the top-of-seed scaffolding that always renders:
// `## 上下文摘要…` header (~30 char), `### …` section titles for up to ~5
// summarised sections (~30 char each), and Markdown spacers between sections.
// Cap rationale: 200 covers worst case without eating too much earlyBudget;
// underestimating just means buckets get a few-hundred extra chars that the
// fallback can drop. Never underflows.
const HEADER_OVERHEAD_RESERVE = 200;

// Reserve for the `---` separator and the trailing blank line between the
// last summarised section and the recent block / trailer.
const SECTION_SEPARATOR_RESERVE = 40;

// Reserve when shrinkRecentRegion has to truncate a single-turn body: the
// `---`, section title, `#### 第 1 轮`, `**用户**:` / `**我**:` role labels
// plus newlines around them. Same magnitude as HEADER_OVERHEAD_RESERVE but
// scoped to the recent-block re-render path; named separately for clarity.
const RECENT_SINGLE_TURN_HEADER_RESERVE = 200;

// Anything below this many remaining chars in a bucket is not worth splicing
// a head/tail-truncated message into — bail out instead.
const MIN_TRUNCATE_CHARS = 120;

const DEFAULT_TRAILER = [
    '---',
    '注意：以上摘要由 happy /compact 本地启发式生成，可能不完整（工具输出、推理过程、diff 详情已被丢弃）。',
    '若用户问及的内容不在摘要中，请勿假设"未讨论过" — 应当反问澄清或主动承认信息缺失。',
].join('\n');

interface CompactedReplacementMessage {
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string; input_text?: string }>;
}

interface CompactedPayload {
    message?: string;
    replacement_history?: CompactedReplacementMessage[];
}

/**
 * A single conversation turn. Boundary = user message: every user message
 * starts a new Turn; all subsequent assistant messages and tool calls (until
 * the next user message) belong to that Turn.
 *
 * `hasFinalAnswer = false` marks a turn the assistant did not finish — most
 * commonly the very last turn when /compact is triggered mid-response by
 * happy's auto-rescue. Renderer surfaces this so the next thread knows the
 * user's most recent prompt has not been answered yet.
 */
interface Turn {
    userText: string;
    /** assistant final_answer texts only (commentary intentionally dropped). */
    assistantTexts: string[];
    /** File paths touched by shell / apply_patch within this turn. */
    fileEdits: string[];
    hasFinalAnswer: boolean;
}

interface Buckets {
    lastCompacted: CompactedPayload | null;
    /** All turns extracted from rollout + extraUserTexts, in chronological order. */
    allTurns: Turn[];
    /** Cross-turn union of file edits (for the dedicated files section). */
    fileEdits: Set<string>;
    /** Per-file accumulated patch line counts (from apply_patch tool calls). */
    patchSummaries: Map<string, { plus: number; minus: number }>;
    todos: unknown | null;
}

interface ScanState {
    buckets: Buckets;
    /** Turn currently being accumulated; flushed on the next user message or end-of-stream. */
    currentTurn: Turn | null;
}

function emptyBuckets(): Buckets {
    return {
        lastCompacted: null,
        allTurns: [],
        fileEdits: new Set(),
        patchSummaries: new Map(),
        todos: null,
    };
}

function makeTurn(userText: string): Turn {
    return {
        userText,
        assistantTexts: [],
        fileEdits: [],
        hasFinalAnswer: false,
    };
}

function flushCurrentTurn(state: ScanState): void {
    if (state.currentTurn) {
        state.buckets.allTurns.push(state.currentTurn);
        state.currentTurn = null;
    }
}

const FILE_PATH_RE = /\b([\w./\\-]+\.[a-zA-Z]{1,5})\b/g;

function extractMessageText(content: unknown): string {
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        const o = c as Record<string, unknown>;
        const text = (typeof o.text === 'string' && o.text)
            || (typeof o.input_text === 'string' && o.input_text)
            || (typeof o.output_text === 'string' && o.output_text);
        if (text) parts.push(text as string);
    }
    return parts.join('');
}

function isNoiseUserMessage(text: string): boolean {
    if (!text) return true;
    if (text.includes('<environment_context>')) return true;
    if (text.startsWith('<permissions') || text.includes('<permissions instructions>')) return true;
    if (text.startsWith('<system')) return true;
    return false;
}

// Sensitive value patterns. Anything matching is replaced before the text
// enters the seed — including user prompts, assistant answers and shell
// commands. Replacements preserve enough surrounding context that the next
// session can still see "we set api_key = [REDACTED]" rather than losing the
// fact entirely.
const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
    // OpenAI / Anthropic style keys (sk-..., sk-ant-...)
    [/sk-(?:ant-)?[A-Za-z0-9_\-]{20,}/g, '[REDACTED-API-KEY]'],
    // GitHub personal access tokens
    [/\bghp_[A-Za-z0-9]{30,}/g, '[REDACTED-GH-PAT]'],
    [/\bgithub_pat_[A-Za-z0-9_]{50,}/g, '[REDACTED-GH-PAT]'],
    // Slack bot/user/app tokens
    [/\bxox[abprs]-[A-Za-z0-9\-]{10,}/g, '[REDACTED-SLACK]'],
    // AWS access key id
    [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED-AWS]'],
    // JWT (header.payload.signature)
    [/\beyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\b/g, '[REDACTED-JWT]'],
    // HTTP Authorization header (bearer / basic)
    [/(Authorization\s*:\s*)(?:Bearer|Basic|Token)\s+\S+/gi, '$1[REDACTED]'],
    // Generic name=value (api_key, secret, password, access_token, ...)
    // Capture the variable name + delimiter, replace only the value.
    [/\b((?:api[_-]?key|secret|access[_-]?token|password|passwd|auth[_-]?token|bearer|client[_-]?secret)["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-+=/.~]{8,})/gi, '$1[REDACTED]'],
];

function redactSensitive(text: string): string {
    if (!text) return text;
    let result = text;
    for (const [re, replacement] of SENSITIVE_PATTERNS) {
        result = result.replace(re, replacement);
    }
    return result;
}

/**
 * Extract a per-file +N/-M change summary from an apply_patch invocation.
 * Codex's patch format wraps hunks under `*** Update File:` / `*** Add File:` /
 * `*** Delete File:` headers; we count `+`/`-` prefixed lines per file and
 * accumulate into buckets.patchSummaries. Path is also added to fileEdits so
 * the seed lists every file ever touched, even if we lose +/- counts.
 */
function extractPatchSummary(args: Record<string, unknown>, buckets: Buckets, currentTurn: Turn | null): void {
    const input = String(args.input ?? args.patch ?? '');
    if (!input || !input.includes('*** ')) return;
    const fileHead = /^\*\*\*\s+(Update|Add|Delete)\s+File:\s+(\S.*?)\s*$/;
    let currentPath: string | null = null;
    let plus = 0;
    let minus = 0;
    const flush = () => {
        if (currentPath) {
            buckets.fileEdits.add(currentPath);
            if (currentTurn) currentTurn.fileEdits.push(currentPath);
            if (plus > 0 || minus > 0) {
                const prev = buckets.patchSummaries.get(currentPath) ?? { plus: 0, minus: 0 };
                buckets.patchSummaries.set(currentPath, {
                    plus: prev.plus + plus,
                    minus: prev.minus + minus,
                });
            }
        }
        plus = 0;
        minus = 0;
    };
    for (const line of input.split('\n')) {
        const fm = fileHead.exec(line);
        if (fm) {
            flush();
            currentPath = fm[2].trim();
            continue;
        }
        if (line.startsWith('+') && !line.startsWith('+++')) plus++;
        else if (line.startsWith('-') && !line.startsWith('---')) minus++;
    }
    flush();
}

function processResponseItem(payload: Record<string, unknown>, state: ScanState): void {
    const { buckets } = state;
    const ptype = payload.type;

    if (ptype === 'message') {
        const role = payload.role;
        const text = extractMessageText(payload.content);

        if (role === 'user' && !isNoiseUserMessage(text)) {
            // SEED_SENTINEL routing has the highest priority among user
            // messages: a happy-injected seed from a prior /compact must
            // become the `lastCompacted` payload so it occupies the
            // dedicated compacted bucket instead of accumulating as raw
            // user history. This prevents the per-compaction seed-bloat
            // loop documented at SEED_SENTINEL.
            if (text.startsWith(SEED_SENTINEL)) {
                flushCurrentTurn(state);
                buckets.lastCompacted = {
                    message: 'happy-injected seed',
                    replacement_history: [{
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text }],
                    }],
                };
                // Discard everything before sentinel: the seed already
                // summarises it. Aggregate signals (fileEdits/todos) stay.
                buckets.allTurns = [];
                return;
            }
            // New user message → close out previous turn, start fresh.
            flushCurrentTurn(state);
            state.currentTurn = makeTurn(redactSensitive(text));
            return;
        }

        if (role === 'assistant' && text) {
            // Only final_answer text enters the seed. commentary is codex's
            // "thinking aloud" and provides no value to the next thread.
            // Without a currentTurn the message is orphaned (typically a
            // pre-user-message system note) — drop it.
            if (payload.phase === 'final_answer' && state.currentTurn) {
                state.currentTurn.assistantTexts.push(redactSensitive(text));
                state.currentTurn.hasFinalAnswer = true;
            }
        }
        return;
    }

    if (ptype === 'function_call') {
        const argsStr = typeof payload.arguments === 'string' ? payload.arguments : '';
        const name = typeof payload.name === 'string' ? payload.name : '';
        if (!argsStr) return;
        try {
            const args = JSON.parse(argsStr) as Record<string, unknown>;
            const cmdLine = String(args.command ?? args.input ?? args.path ?? '');
            if (cmdLine) {
                for (const m of cmdLine.matchAll(FILE_PATH_RE)) {
                    const p = m[1];
                    if (p && !p.startsWith('http') && p.length < 300) {
                        buckets.fileEdits.add(p);
                        if (state.currentTurn) state.currentTurn.fileEdits.push(p);
                        if (buckets.fileEdits.size > MAX_FILE_PATHS * 4) {
                            // Cap aggressive growth; composition picks top N.
                            return;
                        }
                    }
                }
            }
            if (name === 'apply_patch' || /apply[_-]?patch/i.test(name)) {
                extractPatchSummary(args, buckets, state.currentTurn);
            }
            if (name === 'set_todos' || name === 'update_todos' || /todos?$/i.test(name)) {
                if (args.todos !== undefined) buckets.todos = args.todos;
            }
        } catch {
            // arguments is not always valid JSON; ignore
        }
    }
}

function processCompacted(payload: CompactedPayload, state: ScanState): void {
    // A `compacted` record means codex replaced earlier history. Close any
    // in-flight turn, discard all prior turns, and store the compaction
    // payload as the new origin. Aggregate signals (fileEdits/todos) stay —
    // they are not chronological.
    flushCurrentTurn(state);
    state.buckets.lastCompacted = payload;
    state.buckets.allTurns = [];
}

export interface BuildSeedOptions {
    rolloutPath: string;
    tokenBudget?: number;
    /** Optional: included verbatim as the closing line of the seed. */
    trailerNote?: string;
    /**
     * In-memory user messages to splice in as additional turns at the END of
     * the conversation, AFTER rollout-scanned content. Use case: a /compact
     * (manual or auto-rescue) fired before codex flushed the latest user
     * input to rollout.jsonl — without this, the freshest "what did the
     * user just ask" turn silently vanishes from the seed. Each entry
     * becomes its own Turn with `hasFinalAnswer = false`, so it lands in
     * the recent-turns must-keep region.
     *
     * Same filters as scanned messages: env_context / permissions noise is
     * dropped; sensitive patterns are redacted. SEED_SENTINEL is honoured —
     * a prior-compact seed passed here will swap into the compacted bucket.
     */
    extraUserTexts?: string[];
    /**
     * How many of the most recent turns to keep verbatim in the seed. These
     * turns are NEVER truncated by bucket budgets or the global fallback.
     * Defaults to DEFAULT_RECENT_TURNS_TO_KEEP (3). Set to 0 to disable the
     * must-keep region (the entire conversation becomes summarisable).
     */
    recentTurnsToKeep?: number;
}

export interface BuildSeedResult {
    seedText: string;
    /**
     * Final rendered text of the must-keep recent region (post-shrink),
     * with the `### 最近 N 轮完整对话（不可压缩）` heading and verbatim
     * `**用户**:` / `**我**:` turn bodies. Empty when no recent turns were
     * reserved (caller set `recentTurnsToKeep: 0` or rollout had < 1 turn).
     *
     * The caller is expected to re-append this block when L2 replaces
     * `seedText` with an LLM narrative — the heuristic's must-keep promise
     * only survives if the verbatim text is re-spliced after L2.
     */
    recentBlock: string;
    stats: {
        /** Total conversation turns recognised (rollout + extras, post-sentinel). */
        userTurns: number;
        /** Turns whose assistant produced a final_answer. */
        finalAnswers: number;
        fileEdits: number;
        hadCompactedRecord: boolean;
        approximateTokens: number;
        /** Per-bucket char usage in the *early* (summarised) region. */
        bucketUsage: {
            compacted: number;
            user: number;
            assistant: number;
            files: number;
            todos: number;
        };
        /** Number of turns reserved for the must-keep recent block. */
        recentTurnsCount: number;
        /** Number of turns relegated to the summarised early region. */
        earlyTurnsCount: number;
        /** Total chars consumed by the must-keep recent block (verbatim). */
        recentTurnsChars: number;
        /** True if section-aware fallback dropped early sections to fit budget. */
        fallbackTriggered: boolean;
        /** Names of sections dropped by fallback (e.g. ['todos','files']). */
        droppedSections: string[];
    };
}

export async function buildHeuristicSeed(opts: BuildSeedOptions): Promise<BuildSeedResult> {
    const tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const recentTurnsToKeep = Math.max(0, opts.recentTurnsToKeep ?? DEFAULT_RECENT_TURNS_TO_KEEP);
    const state: ScanState = {
        buckets: emptyBuckets(),
        currentTurn: null,
    };

    const stream = createReadStream(opts.rolloutPath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let lineNum = 0;
    try {
        for await (const line of rl) {
            lineNum++;
            if (!line.trim()) continue;
            let r: Record<string, unknown>;
            try {
                r = JSON.parse(line);
            } catch {
                continue; // tolerate partial last line during active codex writes
            }
            const t = r.type;
            const payload = r.payload as Record<string, unknown> | undefined;
            if (!payload) continue;

            if (t === 'compacted') {
                processCompacted(payload as CompactedPayload, state);
                continue;
            }
            if (t === 'response_item') {
                processResponseItem(payload, state);
            }
            // Other types (event_msg, turn_context, session_meta) are ignored
            // by design — they carry no useful seed content.
        }
    } catch (err) {
        logger.debug(`[compactSeedBuilder] read failed at line ${lineNum}: ${(err as Error).message}`);
    }

    // Splice in in-memory user messages that may not have hit rollout yet.
    // Each extra becomes its own Turn (hasFinalAnswer = false) so it lands
    // in the must-keep recent region. Reusing processResponseItem keeps
    // SEED_SENTINEL routing, noise filtering and redaction in lock-step
    // with rollout-sourced messages — and flushes the in-flight turn first
    // so an extra never accidentally merges into the rollout's last turn.
    if (opts.extraUserTexts) {
        for (const text of opts.extraUserTexts) {
            if (typeof text !== 'string' || !text) continue;
            processResponseItem({
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text }],
            }, state);
        }
    }

    // End-of-input: commit any unflushed in-flight turn.
    flushCurrentTurn(state);

    const buckets = state.buckets;

    // Split allTurns → earlyTurns + recentTurns. The recent block is what
    // we guarantee verbatim; the early block goes through bucket summarisation.
    const recentTurns: Turn[] = recentTurnsToKeep > 0
        ? buckets.allTurns.splice(-recentTurnsToKeep)
        : [];
    const earlyTurns: Turn[] = buckets.allTurns;
    const finalAnswerCount = countFinalAnswers(earlyTurns) + countFinalAnswers(recentTurns);

    const composed = composeSeed(buckets, earlyTurns, recentTurns, tokenBudget, opts.trailerNote);

    return {
        seedText: composed.seedText,
        recentBlock: composed.recentBlock,
        stats: {
            userTurns: earlyTurns.length + recentTurns.length,
            finalAnswers: finalAnswerCount,
            fileEdits: buckets.fileEdits.size,
            hadCompactedRecord: buckets.lastCompacted !== null,
            approximateTokens: Math.ceil(composed.seedText.length / TOKEN_CHAR_RATIO),
            bucketUsage: composed.bucketUsage,
            recentTurnsCount: recentTurns.length,
            earlyTurnsCount: earlyTurns.length,
            recentTurnsChars: composed.recentTurnsChars,
            fallbackTriggered: composed.fallbackTriggered,
            droppedSections: composed.droppedSections,
        },
    };
}

function countFinalAnswers(turns: Turn[]): number {
    let n = 0;
    for (const t of turns) if (t.hasFinalAnswer) n++;
    return n;
}

interface ComposeResult {
    seedText: string;
    bucketUsage: {
        compacted: number;
        user: number;
        assistant: number;
        files: number;
        todos: number;
    };
    recentTurnsChars: number;
    /**
     * Final rendered text of the must-keep recent region (post-shrink). Empty
     * string when there are no recent turns. Exposed separately so the L2
     * pipeline can re-append it verbatim after `wrapL2SeedAsHeuristicSeed`
     * replaces the heuristic seed with the LLM narrative — the only way to
     * keep the "recent K turns verbatim" contract intact when L2 succeeds.
     */
    recentBlock: string;
    fallbackTriggered: boolean;
    droppedSections: string[];
}

/**
 * Last-resort character truncation. Keep head 40% + tail 60% with an elision
 * marker. Used only when smartTruncate cannot apply (single-paragraph text or
 * a single block that is itself larger than the budget).
 */
function headTailTruncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const ELISION = ' [...中间省略...] ';
    if (maxChars < ELISION.length + 60) {
        // Too small to fit head + tail meaningfully — single truncation
        return text.slice(0, Math.max(0, maxChars - 1)) + '…';
    }
    const remaining = maxChars - ELISION.length;
    const headLen = Math.floor(remaining * 0.4);
    const tailLen = remaining - headLen;
    return text.slice(0, headLen) + ELISION + text.slice(-tailLen);
}

interface Block {
    text: string;
    /** Code fence — must never be split. Always preserved if it fits. */
    isCodeBlock: boolean;
    /** Markdown pipe-table — must never be split (rows are useless without header). */
    isTable: boolean;
    /** Heuristic-flagged as load-bearing (contains conclusion/TL;DR/warning markers). */
    isImportant: boolean;
}

const TABLE_LINE_RE = /^\s*\|.*\|\s*$/;

const KEYWORDS_IMPORTANT = [
    '结论', '总结', '关键', '重要', '注意', '警告', '小结', '决策', '方案',
    'tl;dr', 'tldr', 'summary', 'conclusion', 'note:', 'warning', 'important',
    '⚠️', '🔴', '✅', '❌',
];

function hasImportantKeyword(text: string): boolean {
    const lower = text.toLowerCase();
    for (const k of KEYWORDS_IMPORTANT) {
        if (lower.includes(k)) return true;
    }
    return false;
}

/**
 * Split a non-code segment into paragraph and table blocks. Markdown pipe
 * tables (≥2 consecutive `|...|` lines) are atomic — splitting a table loses
 * the header row and breaks alignment. Everything else uses blank-line boundaries.
 */
function splitNonCodeSegment(segment: string, blocks: Block[]): void {
    const lines = segment.split('\n');
    let paraBuf: string[] = [];
    let tableBuf: string[] = [];

    const flushPara = () => {
        if (paraBuf.length === 0) return;
        const joined = paraBuf.join('\n');
        for (const para of joined.split(/\n\s*\n+/)) {
            const trimmed = para.trim();
            if (!trimmed) continue;
            blocks.push({
                text: trimmed,
                isCodeBlock: false,
                isTable: false,
                isImportant: hasImportantKeyword(trimmed),
            });
        }
        paraBuf = [];
    };
    const flushTable = () => {
        if (tableBuf.length >= 2) {
            blocks.push({
                text: tableBuf.join('\n'),
                isCodeBlock: false,
                isTable: true,
                // Tables typically encode decision matrices / comparisons —
                // mark them important so smartTruncate prioritises keeping them.
                isImportant: true,
            });
        } else if (tableBuf.length === 1) {
            // Single |...| line is not a real table; treat as paragraph
            paraBuf.push(...tableBuf);
        }
        tableBuf = [];
    };

    for (const line of lines) {
        if (TABLE_LINE_RE.test(line)) {
            if (paraBuf.length > 0) flushPara();
            tableBuf.push(line);
        } else {
            if (tableBuf.length > 0) flushTable();
            paraBuf.push(line);
        }
    }
    if (tableBuf.length > 0) flushTable();
    if (paraBuf.length > 0) flushPara();
}

/**
 * Split text into atomic blocks. Two block types are preserved as single
 * units (never split):
 *   - Code fences (```...```)
 *   - Markdown pipe tables (≥2 consecutive `|...|` lines)
 * Everything else is split on blank-line boundaries.
 */
function splitIntoBlocks(text: string): Block[] {
    const blocks: Block[] = [];
    const codeRe = /```[\s\S]*?```/g;
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = codeRe.exec(text)) !== null) {
        if (m.index > cursor) {
            splitNonCodeSegment(text.slice(cursor, m.index), blocks);
        }
        blocks.push({ text: m[0], isCodeBlock: true, isTable: false, isImportant: true });
        cursor = m.index + m[0].length;
    }
    if (cursor < text.length) {
        splitNonCodeSegment(text.slice(cursor), blocks);
    }
    return blocks;
}

/**
 * Block-aware truncation. Strategy (in order of priority):
 *  1. Always keep first block (intent) and last block (conclusion).
 *  2. Always keep code blocks if they fit — they're high-density signal.
 *  3. Always keep blocks containing important keywords (结论/TL;DR/⚠️ etc).
 *  4. Fill remaining budget from outer edges inward (newest+oldest preferred
 *     over middle), preserving chronological flow.
 *  5. Skipped blocks collapse to `[...省略 N 段...]` markers in their original
 *     position so the reader sees the gap structure.
 *
 * Falls back to headTailTruncate when:
 *  - text is a single block (no paragraph structure to leverage), or
 *  - first+last blocks alone already exceed the budget.
 */
function smartTruncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;

    const blocks = splitIntoBlocks(text);
    if (blocks.length <= 1) {
        return headTailTruncate(text, maxChars);
    }

    const N = blocks.length;
    const SEP_COST = 2; // "\n\n" between kept blocks
    const ELISION_COST = 24; // "[...省略 N 段...]" with separators

    const blockCost = (i: number) => blocks[i].text.length + SEP_COST;

    // Anchors: first + last
    const firstCost = blockCost(0);
    const lastCost = N > 1 ? blockCost(N - 1) : 0;
    if (firstCost + lastCost > maxChars) {
        // Can't even fit anchors — fall back to char-level cut
        return headTailTruncate(text, maxChars);
    }

    const keep = new Array<boolean>(N).fill(false);
    keep[0] = true;
    if (N > 1) keep[N - 1] = true;
    let used = firstCost + lastCost;

    // Pass A: always-keep code blocks and keyword-important blocks (priority order)
    const tryAdd = (i: number) => {
        if (keep[i]) return false;
        const cost = blockCost(i);
        if (used + cost > maxChars) return false;
        keep[i] = true;
        used += cost;
        return true;
    };

    // Atomic units (code blocks, tables) get top priority — they carry
    // structural meaning that's destroyed by partial keeping.
    for (let i = 1; i < N - 1; i++) if (blocks[i].isCodeBlock || blocks[i].isTable) tryAdd(i);
    for (let i = 1; i < N - 1; i++) if (blocks[i].isImportant) tryAdd(i);

    // Pass B: fill from outer edges inward (preserves chronological "head+tail" feel)
    let left = 1;
    let right = N - 2;
    while (left <= right) {
        const addedL = tryAdd(left);
        const addedR = left !== right ? tryAdd(right) : false;
        if (!addedL && !addedR) break;
        left++;
        right--;
    }

    // Render: keep order, collapse runs of skipped blocks into "[...省略 N 段...]"
    const out: string[] = [];
    let elided = 0;
    for (let i = 0; i < N; i++) {
        if (keep[i]) {
            if (elided > 0) {
                out.push(`[...省略 ${elided} 段...]`);
                elided = 0;
            }
            out.push(blocks[i].text);
        } else {
            elided++;
        }
    }
    if (elided > 0) out.push(`[...省略 ${elided} 段...]`);

    let result = out.join('\n\n');
    // Hard cap: pathological inputs (giant first/last block) might still overflow
    if (result.length > maxChars + ELISION_COST) {
        result = headTailTruncate(result, maxChars);
    }
    return result;
}

/**
 * Pack messages newest-first into a char budget, returning each kept entry
 * as `- {text}`. Order is restored to chronological (oldest → newest) on
 * return. Buckets only summarise the EARLY region; the must-keep recent
 * region is reserved by composeSeed before bucket allocation, so there is
 * no "force-keep" mode here — overflow truncates the budget-overflowing
 * message via smartTruncate (which preserves head + tail) and drops older
 * messages entirely.
 */
function packBucket(
    texts: string[],
    charBudget: number,
): { lines: string[]; used: number } {
    const collected: string[] = [];
    let used = 0;
    const reversed = [...texts].reverse(); // newest first

    for (const t of reversed) {
        const prefixCost = 4; // "- " + "\n"
        const fullCost = t.length + prefixCost;
        const remaining = charBudget - used;
        if (fullCost <= remaining) {
            collected.push(t);
            used += fullCost;
        } else if (remaining >= MIN_TRUNCATE_CHARS) {
            const truncated = smartTruncate(t, remaining - prefixCost);
            collected.push(truncated);
            used += truncated.length + prefixCost;
            break; // bucket exhausted; older messages are dropped
        } else {
            break;
        }
    }

    return {
        lines: collected.reverse().map(t => `- ${t}`),
        used,
    };
}

type BucketKey = 'compacted' | 'user' | 'assistant' | 'files' | 'todos';

interface BucketWants {
    compacted: number;
    user: number;
    assistant: number;
    files: number;
    todos: number;
}

function pathRenderLength(path: string, summary: { plus: number; minus: number } | undefined): number {
    const tag = summary ? ` (+${summary.plus}/-${summary.minus})` : '';
    return path.length + tag.length + 4; // "- " + path + tag + "\n"
}

/**
 * Estimate how many chars each bucket *wants* if it had unlimited budget.
 * Buckets summarise EARLY turns only — the recent must-keep block is
 * reserved separately by composeSeed before bucket allocation runs.
 */
function estimateBucketWants(buckets: Buckets, earlyTurns: Turn[]): BucketWants {
    let compacted = 0;
    if (buckets.lastCompacted?.replacement_history) {
        for (const msg of buckets.lastCompacted.replacement_history) {
            if (msg.role !== 'user') continue;
            const t = extractMessageText(msg.content);
            if (!t || isNoiseUserMessage(t)) continue;
            compacted += t.length + 4;
        }
    }
    let user = 0;
    let assistant = 0;
    for (const turn of earlyTurns) {
        user += turn.userText.length + 4;
        for (const a of turn.assistantTexts) assistant += a.length + 4;
    }
    const allPaths = Array.from(buckets.fileEdits).slice(0, MAX_FILE_PATHS);
    const files = allPaths.reduce((acc, p) => acc + pathRenderLength(p, buckets.patchSummaries.get(p)), 0);
    let todos = 0;
    if (buckets.todos) {
        try {
            todos = JSON.stringify(buckets.todos, null, 2).length + 30;
        } catch {
            todos = 0;
        }
    }
    return { compacted, user, assistant, files, todos };
}

/**
 * Allocate the global char budget across buckets in two passes:
 *  Pass 1 — each bucket gets min(want, ratio × budget). Buckets with low demand
 *           leave surplus on the table.
 *  Pass 2 — surplus is distributed by priority order (user > assistant >
 *           compacted > files > todos) to buckets that still want more.
 * This means a chat-heavy session can pour user-bucket leftover into a
 * code-heavy assistant answer, and vice versa.
 */
function allocateBucketBudgets(wants: BucketWants, charBudget: number): BucketWants {
    const PRIORITY: BucketKey[] = ['user', 'assistant', 'compacted', 'files', 'todos'];
    const allocated: BucketWants = { compacted: 0, user: 0, assistant: 0, files: 0, todos: 0 };
    let used = 0;

    // Pass 1: each bucket's static ratio cap
    for (const k of PRIORITY) {
        const cap = Math.floor(charBudget * BUCKET_RATIOS[k]);
        const give = Math.min(wants[k], cap);
        allocated[k] = give;
        used += give;
    }

    // Pass 2: distribute surplus by priority to buckets that still want more
    let remaining = charBudget - used;
    for (const k of PRIORITY) {
        if (remaining <= 0) break;
        const stillWants = wants[k] - allocated[k];
        if (stillWants > 0) {
            const give = Math.min(stillWants, remaining);
            allocated[k] += give;
            remaining -= give;
        }
    }

    return allocated;
}

/**
 * Render the must-keep recent-turns block. Each turn is rendered as a
 * markdown section with "**用户**:" / "**我**:" / "**涉及文件**:" sub-headers
 * so a downstream model reads them as cleanly-paired Q&A with per-turn file
 * context. Turns missing a final_answer (typically the very last turn when
 * /compact triggered mid-response) get an explicit annotation so the next
 * thread does not pretend the user has already been answered.
 *
 * The per-turn `**涉及文件**:` line is the turn-anchored design's edge over
 * the cross-turn `### 涉及的文件路径` aggregate: the model can correlate
 * "what was edited" with "which prompt asked for the edit", not just see a
 * flat union of every file ever touched in the conversation.
 */
/**
 * De-dupe file paths within a single turn while preserving first-seen order.
 * apply_patch and shell calls within the same turn often mention the same
 * file; we want one entry per file but in touch order so the model can see
 * a coherent "read → patch" sequence.
 */
function dedupeFileEdits(fileEdits: string[]): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const p of fileEdits) {
        if (seen.has(p)) continue;
        seen.add(p);
        ordered.push(p);
    }
    return ordered;
}

function renderRecentTurns(turns: Turn[]): string {
    if (turns.length === 0) return '';
    const lines: string[] = [];
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`### 最近 ${turns.length} 轮完整对话（不可压缩，请基于此继续）`);
    for (let i = 0; i < turns.length; i++) {
        const t = turns[i];
        const heading = t.hasFinalAnswer
            ? `\n#### 第 ${i + 1} 轮`
            : `\n#### 第 ${i + 1} 轮（回答未完成）`;
        lines.push(heading);
        lines.push(`**用户**: ${t.userText}`);
        if (t.assistantTexts.length > 0) {
            lines.push(`**我**: ${t.assistantTexts.join('\n\n')}`);
        }
        if (t.fileEdits.length > 0) {
            lines.push(`**涉及文件**: ${dedupeFileEdits(t.fileEdits).join(', ')}`);
        }
    }
    return lines.join('\n');
}

/**
 * Last-resort handling when even the must-keep region exceeds the budget.
 * Drop oldest turns whole, never cutting mid-turn — message-boundary
 * integrity is the industry contract. If a single turn alone exceeds
 * the budget, fall through to smartTruncate on its userText/assistantTexts
 * with an explicit warning so the next thread knows truncation happened.
 */
function shrinkRecentRegion(turns: Turn[], maxChars: number): { text: string; keptCount: number; warning: string | null } {
    if (turns.length === 0) return { text: '', keptCount: 0, warning: null };

    // Try dropping oldest turns until the remainder fits.
    for (let dropOldest = 0; dropOldest < turns.length; dropOldest++) {
        const kept = turns.slice(dropOldest);
        const rendered = renderRecentTurns(kept);
        if (rendered.length <= maxChars) {
            return {
                text: rendered,
                keptCount: kept.length,
                warning: dropOldest > 0
                    ? `\n\n> ⚠️ 必保区因超出预算丢弃了最老的 ${dropOldest} 轮对话。`
                    : null,
            };
        }
    }

    // Even keeping the single newest turn overflows — smartTruncate its body.
    const newest = turns[turns.length - 1];
    const heading = newest.hasFinalAnswer
        ? '\n#### 第 1 轮'
        : '\n#### 第 1 轮（回答未完成）';
    const bodyBudget = Math.max(MIN_TRUNCATE_CHARS, maxChars - RECENT_SINGLE_TURN_HEADER_RESERVE);
    const userBudget = Math.floor(bodyBudget * 0.5);
    const assistantBudget = bodyBudget - userBudget;
    const userText = smartTruncate(newest.userText, userBudget);
    const assistantJoined = newest.assistantTexts.join('\n\n');
    const assistantText = assistantJoined.length > 0
        ? smartTruncate(assistantJoined, assistantBudget)
        : '';

    const out: string[] = ['', '---', '', '### 最近 1 轮完整对话（不可压缩，请基于此继续）', heading];
    out.push(`**用户**: ${userText}`);
    if (assistantText) out.push(`**我**: ${assistantText}`);
    if (newest.fileEdits.length > 0) {
        out.push(`**涉及文件**: ${dedupeFileEdits(newest.fileEdits).join(', ')}`);
    }
    return {
        text: out.join('\n'),
        keptCount: 1,
        warning: `\n\n> ⚠️ 必保区单 turn 超出预算，已对其内部做段落感知截断；丢弃了 ${turns.length - 1} 轮更早对话。`,
    };
}

type SectionKey =
    | 'sentinel'
    | 'header'
    | 'compacted'
    | 'early-user'
    | 'early-assistant'
    | 'files'
    | 'todos'
    | 'recent'
    | 'trailer-spacer'
    | 'trailer'
    | 'trailer-note-spacer'
    | 'trailer-note';

interface Section {
    key: SectionKey;
    text: string;
    droppable: boolean;
    /** Lower priority is dropped first. Only meaningful when droppable=true. */
    dropPriority: number;
}

type BucketUsage = ComposeResult['bucketUsage'];

/**
 * Build the ordered Section list. Always-on sections (sentinel, header,
 * recent must-keep, trailer) are non-droppable; bucket-summarised early
 * sections are droppable with a priority ordering used by applyDropFallback.
 *
 * Returns the populated section array along with per-bucket usage stats.
 */
function buildSeedSections(
    buckets: Buckets,
    earlyTurns: Turn[],
    recentBlock: string,
    budgets: BucketWants,
    trailerNote: string | undefined,
): { sections: Section[]; usage: BucketUsage } {
    const sections: Section[] = [];
    const usage: BucketUsage = { compacted: 0, user: 0, assistant: 0, files: 0, todos: 0 };

    sections.push({ key: 'sentinel', text: SEED_SENTINEL, droppable: false, dropPriority: 0 });
    sections.push({ key: 'header', text: '## 上下文摘要（happy /compact 本地重建）', droppable: false, dropPriority: 0 });

    // 1. codex's own compacted history (droppable, lowest urgency to keep)
    if (buckets.lastCompacted?.replacement_history?.length && budgets.compacted > 0) {
        const compactedTexts: string[] = [];
        for (const msg of buckets.lastCompacted.replacement_history) {
            if (msg.role !== 'user') continue;
            const text = extractMessageText(msg.content);
            if (!text || isNoiseUserMessage(text)) continue;
            compactedTexts.push(text);
        }
        if (compactedTexts.length > 0) {
            const packed = packBucket(compactedTexts, budgets.compacted);
            if (packed.lines.length > 0) {
                const body = ['\n### codex 上次成功压缩的历史', ...packed.lines].join('\n');
                sections.push({ key: 'compacted', text: body, droppable: true, dropPriority: 5 });
                usage.compacted = packed.used;
            }
        }
    }

    // 2. 早期用户指令时序
    if (earlyTurns.length > 0 && budgets.user > 0) {
        const userTexts = earlyTurns.map(t => t.userText);
        const packed = packBucket(userTexts, budgets.user);
        if (packed.lines.length > 0) {
            const body = [
                `\n### 早期用户指令时序（共 ${earlyTurns.length} 条，节选 ${packed.lines.length}）`,
                ...packed.lines,
            ].join('\n');
            sections.push({ key: 'early-user', text: body, droppable: true, dropPriority: 4 });
            usage.user = packed.used;
        }
    }

    // 3. 早期 assistant final_answer
    if (earlyTurns.length > 0 && budgets.assistant > 0) {
        const ansTexts: string[] = [];
        for (const t of earlyTurns) ansTexts.push(...t.assistantTexts);
        if (ansTexts.length > 0) {
            const packed = packBucket(ansTexts, budgets.assistant);
            if (packed.lines.length > 0) {
                const body = [
                    `\n### 我之前给出的关键回答（共 ${ansTexts.length} 条，节选 ${packed.lines.length}）`,
                    ...packed.lines,
                ].join('\n');
                sections.push({ key: 'early-assistant', text: body, droppable: true, dropPriority: 3 });
                usage.assistant = packed.used;
            }
        }
    }

    // 4. 涉及的文件路径 (cross-turn union)
    if (buckets.fileEdits.size > 0 && budgets.files > 0) {
        const allPaths = Array.from(buckets.fileEdits);
        const paths: string[] = [];
        let pathUsed = 0;
        for (const p of allPaths) {
            if (paths.length >= MAX_FILE_PATHS) break;
            const cost = pathRenderLength(p, buckets.patchSummaries.get(p));
            if (pathUsed + cost > budgets.files && paths.length > 0) break;
            paths.push(p);
            pathUsed += cost;
        }
        if (paths.length > 0) {
            const fileLines = [`\n### 涉及的文件路径（共 ${buckets.fileEdits.size}，截取前 ${paths.length}）`];
            for (const p of paths) {
                const summary = buckets.patchSummaries.get(p);
                const tag = summary ? ` (+${summary.plus}/-${summary.minus})` : '';
                fileLines.push(`- ${p}${tag}`);
            }
            sections.push({ key: 'files', text: fileLines.join('\n'), droppable: true, dropPriority: 2 });
            usage.files = pathUsed;
        }
    }

    // 5. 当前 TODO 列表 (lowest priority — most easily rebuildable next turn)
    if (buckets.todos && budgets.todos > 0) {
        let todosBlock = '';
        try {
            todosBlock = JSON.stringify(buckets.todos, null, 2);
        } catch {
            todosBlock = '';
        }
        if (todosBlock) {
            if (todosBlock.length > budgets.todos) {
                todosBlock = todosBlock.slice(0, budgets.todos) + '\n... (TODO 列表过长，已截断)';
            }
            const body = ['\n### 当前 TODO 列表', '```json', todosBlock, '```'].join('\n');
            sections.push({ key: 'todos', text: body, droppable: true, dropPriority: 1 });
            usage.todos = todosBlock.length;
        }
    }

    // 6. 必保区
    if (recentBlock.length > 0) {
        sections.push({ key: 'recent', text: recentBlock, droppable: false, dropPriority: 0 });
    }

    // 7. trailer (must-keep)
    sections.push({ key: 'trailer-spacer', text: '', droppable: false, dropPriority: 0 });
    sections.push({ key: 'trailer', text: DEFAULT_TRAILER, droppable: false, dropPriority: 0 });
    if (trailerNote) {
        sections.push({ key: 'trailer-note-spacer', text: '', droppable: false, dropPriority: 0 });
        sections.push({ key: 'trailer-note', text: trailerNote, droppable: false, dropPriority: 0 });
    }

    return { sections, usage };
}

function joinSections(sections: Section[]): string {
    return sections.map(s => s.text).join('\n');
}

// Map droppable section keys to the bucket-usage field they account for.
// Partial because non-droppable sections (sentinel, header, recent, trailer)
// have no usage attribution. Typed against SectionKey so renaming a key in
// the union immediately surfaces a TS error at every map entry, instead of
// silently de-syncing the fallback bookkeeping.
const USAGE_BUCKET_BY_SECTION: Partial<Record<SectionKey, keyof BucketUsage>> = {
    'compacted': 'compacted',
    'early-user': 'user',
    'early-assistant': 'assistant',
    'files': 'files',
    'todos': 'todos',
};

/**
 * Drop droppable early-region sections in priority order until total length
 * fits budget. Section text is cleared to '' (in place) rather than spliced
 * so indices stay stable. Returns the resulting seed text and the list of
 * dropped section keys; also resets the corresponding bucket usage counters
 * so stats reflect what actually rendered.
 */
function applyDropFallback(
    sections: Section[],
    charBudget: number,
    usage: BucketUsage,
): { seed: string; droppedSections: string[]; fallbackTriggered: boolean } {
    let seed = joinSections(sections);
    if (seed.length <= charBudget) {
        return { seed, droppedSections: [], fallbackTriggered: false };
    }

    const dropOrder = sections
        .map((s, i) => ({ s, i }))
        .filter(x => x.s.droppable && x.s.text.length > 0)
        .sort((a, b) => a.s.dropPriority - b.s.dropPriority);

    const droppedSections: string[] = [];
    for (const { i, s } of dropOrder) {
        droppedSections.push(s.key);
        const usageKey = USAGE_BUCKET_BY_SECTION[s.key];
        if (usageKey) usage[usageKey] = 0;
        sections[i].text = '';
        seed = joinSections(sections);
        if (seed.length <= charBudget) break;
    }
    return { seed, droppedSections, fallbackTriggered: true };
}

/**
 * Last-resort: after dropping every droppable section we're still over
 * budget — the must-keep recent block alone exceeds the limit. Shrink it by
 * dropping oldest turns whole (never mid-cut). Returns the new seed text and
 * the updated rendered length of the recent block.
 */
function shrinkRecentIfNeeded(
    sections: Section[],
    recentTurns: Turn[],
    charBudget: number,
    seed: string,
    droppedSections: string[],
): { seed: string; recentChars: number } {
    const recentIdx = sections.findIndex(s => s.key === 'recent');
    if (seed.length <= charBudget || recentTurns.length === 0 || recentIdx < 0) {
        return {
            seed,
            recentChars: recentIdx >= 0 ? sections[recentIdx].text.length : 0,
        };
    }

    const fixedRemaining = seed.length - sections[recentIdx].text.length;
    const recentMaxChars = Math.max(MIN_TRUNCATE_CHARS, charBudget - fixedRemaining);
    const shrunk = shrinkRecentRegion(recentTurns, recentMaxChars);
    sections[recentIdx].text = shrunk.text + (shrunk.warning ?? '');
    droppedSections.push(`recent-shrunk(kept-${shrunk.keptCount}/${recentTurns.length})`);
    return {
        seed: joinSections(sections),
        recentChars: shrunk.text.length,
    };
}

function composeSeed(
    buckets: Buckets,
    earlyTurns: Turn[],
    recentTurns: Turn[],
    tokenBudget: number,
    trailerNote?: string,
): ComposeResult {
    const charBudget = tokenBudget * TOKEN_CHAR_RATIO;

    // Phase 1: reserve must-keep region first. Recent turns are protected;
    // we compute their rendered size up front and subtract from the global
    // budget so bucket allocation only sees what's actually available for
    // the summarised early region.
    const fixedOverhead = SEED_SENTINEL.length
        + HEADER_OVERHEAD_RESERVE
        + DEFAULT_TRAILER.length
        + (trailerNote?.length ?? 0)
        + SECTION_SEPARATOR_RESERVE;
    const recentBlock = renderRecentTurns(recentTurns);
    const earlyBudget = Math.max(0, charBudget - recentBlock.length - fixedOverhead);

    // Phase 2: bucket allocation on the EARLY region only.
    const wants = estimateBucketWants(buckets, earlyTurns);
    const budgets = allocateBucketBudgets(wants, earlyBudget);

    // Phase 3: build sections.
    const { sections, usage } = buildSeedSections(buckets, earlyTurns, recentBlock, budgets, trailerNote);

    // Phase 4: section-aware fallback (drops early sections in priority order).
    const dropResult = applyDropFallback(sections, charBudget, usage);

    // Phase 5: must-keep region overflow handling (shrink whole turns, never mid-cut).
    const shrinkResult = shrinkRecentIfNeeded(
        sections,
        recentTurns,
        charBudget,
        dropResult.seed,
        dropResult.droppedSections,
    );

    // Snapshot the FINAL rendered recent-block text. `sections[recentIdx].text`
    // reflects any shrink applied in Phase 5 (and the recent section itself is
    // non-droppable in Phase 4). Empty when no recent turns were reserved.
    const recentIdx = sections.findIndex(s => s.key === 'recent');
    const recentBlock = recentIdx >= 0 ? sections[recentIdx].text : '';

    return {
        seedText: shrinkResult.seed,
        bucketUsage: usage,
        recentTurnsChars: shrinkResult.recentChars,
        recentBlock,
        fallbackTriggered: dropResult.fallbackTriggered,
        droppedSections: dropResult.droppedSections,
    };
}
