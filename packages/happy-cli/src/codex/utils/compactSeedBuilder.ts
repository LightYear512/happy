/**
 * Heuristic compaction seed builder.
 *
 * Given a codex rollout jsonl file, produce a compact text "seed" that fits
 * into the configured token budget and preserves load-bearing context for a
 * fresh codex conversation. Pure local CPU/IO; no LLM or network involved.
 *
 * Algorithm (single streaming pass + budget-driven composition):
 *  1. If the rollout contains a `compacted` record (codex's own auto-compact
 *     output), reuse its replacement_history as the basis and discard older
 *     dialog buckets. Multiple `compacted` records → keep the latest only.
 *  2. Bucket all subsequent response_items by role/type:
 *      - user message text (filter out env_context / permissions noise)
 *      - assistant message text where phase=final_answer
 *      - file paths mentioned in shell_command / apply_patch arguments
 *      - the most recent set_todos / update_todos arguments
 *  3. Compose markdown seed using **dynamic budget allocation**:
 *      - each bucket gets a share of the global char budget
 *      - within a bucket, walk newest-first; keep full messages while budget
 *        permits, then head/tail-collapse the message that overflows
 *      - the most recent USER_RECENT_FORCE_KEEP user turns are always kept
 *        verbatim (ground-truth intent must not be silently truncated)
 *  4. Append a default safety trailer warning the next session that the seed
 *     may be incomplete (prevents "false amnesia" — model claiming "we never
 *     discussed X" when the discussion is simply outside the seed).
 *  5. If the assembled seed still exceeds the global budget, fall back to a
 *     head-30% / tail-70% collapse with an explicit elision marker.
 *
 * Rationale: 80%+ of rollout volume is tool stdout (function_call_output) and
 * encrypted reasoning, both of which are useless to a new conversation. The
 * static per-message char caps used previously (400/300) were catastrophic for
 * engineering sessions where a single assistant answer can run 5-10k chars —
 * dynamic allocation lets us spend the budget where it matters.
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

// The most recent N user messages are kept verbatim regardless of budget —
// they are ground truth for "what the user actually asked" and silent
// truncation here is the highest-impact failure mode of /compact.
const USER_RECENT_FORCE_KEEP = 3;

// Per-bucket share of the global char budget. Sums to ≤1.0 (remaining slack
// covers section headers, separators, default trailer).
const BUCKET_RATIOS = {
    compacted: 0.20,
    user: 0.35,
    assistant: 0.30,
    files: 0.08,
    todos: 0.05,
} as const;

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

interface Buckets {
    lastCompacted: CompactedPayload | null;
    userTexts: string[];
    finalAnswers: string[];
    fileEdits: Set<string>;
    /** Per-file accumulated patch line counts (from apply_patch tool calls). */
    patchSummaries: Map<string, { plus: number; minus: number }>;
    todos: unknown | null;
}

function emptyBuckets(): Buckets {
    return {
        lastCompacted: null,
        userTexts: [],
        finalAnswers: [],
        fileEdits: new Set(),
        patchSummaries: new Map(),
        todos: null,
    };
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
function extractPatchSummary(args: Record<string, unknown>, buckets: Buckets): void {
    const input = String(args.input ?? args.patch ?? '');
    if (!input || !input.includes('*** ')) return;
    const fileHead = /^\*\*\*\s+(Update|Add|Delete)\s+File:\s+(\S.*?)\s*$/;
    let currentPath: string | null = null;
    let plus = 0;
    let minus = 0;
    const flush = () => {
        if (currentPath) {
            buckets.fileEdits.add(currentPath);
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

function processResponseItem(payload: Record<string, unknown>, buckets: Buckets): void {
    const ptype = payload.type;
    if (ptype === 'message') {
        const role = payload.role;
        const text = extractMessageText(payload.content);
        if (role === 'user' && !isNoiseUserMessage(text)) {
            // Detect happy-injected seed from a prior /compact. When found,
            // synthesise a `lastCompacted` record so it competes for the
            // dedicated 20% compacted bucket instead of the 35% user bucket,
            // and clear earlier user/assistant entries — mirroring the
            // discard-older behaviour of `processCompacted`. This is what
            // breaks the per-compaction seed-bloat loop documented at
            // SEED_SENTINEL.
            if (text.startsWith(SEED_SENTINEL)) {
                buckets.lastCompacted = {
                    message: 'happy-injected seed',
                    replacement_history: [{
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text }],
                    }],
                };
                buckets.userTexts = [];
                buckets.finalAnswers = [];
                return;
            }
            buckets.userTexts.push(redactSensitive(text));
        } else if (role === 'assistant' && payload.phase === 'final_answer' && text) {
            buckets.finalAnswers.push(redactSensitive(text));
        }
        return;
    }

    if (ptype === 'function_call') {
        const argsStr = typeof payload.arguments === 'string' ? payload.arguments : '';
        const name = typeof payload.name === 'string' ? payload.name : '';
        if (argsStr) {
            try {
                const args = JSON.parse(argsStr) as Record<string, unknown>;
                const cmdLine = String(args.command ?? args.input ?? args.path ?? '');
                if (cmdLine) {
                    for (const m of cmdLine.matchAll(FILE_PATH_RE)) {
                        const p = m[1];
                        if (p && !p.startsWith('http') && p.length < 300) {
                            buckets.fileEdits.add(p);
                            if (buckets.fileEdits.size > MAX_FILE_PATHS * 4) {
                                // Cap aggressive growth; we'll pick top N at composition time
                                return;
                            }
                        }
                    }
                }
                if (name === 'apply_patch' || /apply[_-]?patch/i.test(name)) {
                    extractPatchSummary(args, buckets);
                }
                if (name === 'set_todos' || name === 'update_todos' || /todos?$/i.test(name)) {
                    if (args.todos !== undefined) buckets.todos = args.todos;
                }
            } catch {
                // arguments is not always valid JSON; ignore
            }
        }
    }
}

function processCompacted(payload: CompactedPayload, buckets: Buckets): void {
    // A `compacted` record means codex replaced earlier history. Discard older
    // dialog buckets and start fresh from this point on.
    buckets.lastCompacted = payload;
    buckets.userTexts = [];
    buckets.finalAnswers = [];
    // fileEdits, todos kept — they're aggregate signals, not chronological text
}

export interface BuildSeedOptions {
    rolloutPath: string;
    tokenBudget?: number;
    /** Optional: included verbatim as the closing line of the seed. */
    trailerNote?: string;
    /**
     * In-memory user messages to splice in on top of whatever the rollout
     * scan produces. Use case: a /compact (manual or auto-rescue) fired
     * before codex flushed the latest user input to rollout.jsonl — without
     * this, the freshest "what did the user just ask" turn silently vanishes
     * from the seed. Appended in order *after* rollout-scanned messages, so
     * they become the newest entries and are protected by USER_RECENT_FORCE_KEEP.
     *
     * Same filters as scanned messages: env_context / permissions noise is
     * dropped; sensitive patterns are redacted. SEED_SENTINEL is honoured —
     * a prior-compact seed passed here will swap into the compacted bucket.
     */
    extraUserTexts?: string[];
}

export interface BuildSeedResult {
    seedText: string;
    stats: {
        userTurns: number;
        finalAnswers: number;
        fileEdits: number;
        hadCompactedRecord: boolean;
        approximateTokens: number;
        /** Per-bucket char usage after composition; useful for tuning ratios. */
        bucketUsage: {
            compacted: number;
            user: number;
            assistant: number;
            files: number;
            todos: number;
        };
    };
}

export async function buildHeuristicSeed(opts: BuildSeedOptions): Promise<BuildSeedResult> {
    const tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    let buckets = emptyBuckets();

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
                processCompacted(payload as CompactedPayload, buckets);
                continue;
            }
            if (t === 'response_item') {
                processResponseItem(payload, buckets);
            }
            // Other types (event_msg, turn_context, session_meta) are ignored
            // by design — they carry no useful seed content.
        }
    } catch (err) {
        logger.debug(`[compactSeedBuilder] read failed at line ${lineNum}: ${(err as Error).message}`);
    }

    // Splice in in-memory user messages that may not have hit rollout yet.
    // Reuses processResponseItem's message branch so SEED_SENTINEL detection,
    // noise filtering and sensitive redaction stay in lock-step with rollout-
    // sourced messages.
    if (opts.extraUserTexts) {
        for (const text of opts.extraUserTexts) {
            if (typeof text !== 'string' || !text) continue;
            processResponseItem({
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text }],
            }, buckets);
        }
    }

    const composed = composeSeed(buckets, tokenBudget, opts.trailerNote);
    return {
        seedText: composed.seedText,
        stats: {
            userTurns: buckets.userTexts.length,
            finalAnswers: buckets.finalAnswers.length,
            fileEdits: buckets.fileEdits.size,
            hadCompactedRecord: buckets.lastCompacted !== null,
            approximateTokens: Math.ceil(composed.seedText.length / TOKEN_CHAR_RATIO),
            bucketUsage: composed.bucketUsage,
        },
    };
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
 * Pack messages newest-first into a budget. Each kept entry returns as `- {text}`.
 * Output is reversed back to chronological order on return.
 *
 * @param forceKeepCount how many of the newest messages must be kept
 *   verbatim regardless of budget (overflow falls through to global collapse)
 */
function packBucket(
    texts: string[],
    charBudget: number,
    forceKeepCount: number,
): { lines: string[]; used: number } {
    const collected: string[] = [];
    let used = 0;
    const reversed = [...texts].reverse(); // newest first

    for (let i = 0; i < reversed.length; i++) {
        const t = reversed[i];
        const isForceKeep = i < forceKeepCount;
        const prefixCost = 4; // "- " + "\n"
        const fullCost = t.length + prefixCost;

        if (isForceKeep) {
            collected.push(t);
            used += fullCost;
            continue;
        }

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

    // Reverse back to chronological (oldest → newest) for natural reading
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
 * Used to drive cross-bucket reallocation: if user bucket only needs 200 chars,
 * the leftover should flow to assistant rather than being wasted.
 */
function estimateBucketWants(buckets: Buckets): BucketWants {
    let compacted = 0;
    if (buckets.lastCompacted?.replacement_history) {
        for (const msg of buckets.lastCompacted.replacement_history) {
            if (msg.role !== 'user') continue;
            const t = extractMessageText(msg.content);
            if (!t || isNoiseUserMessage(t)) continue;
            compacted += t.length + 4;
        }
    }
    const user = buckets.userTexts.reduce((acc, t) => acc + t.length + 4, 0);
    const assistant = buckets.finalAnswers.reduce((acc, t) => acc + t.length + 4, 0);
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

function composeSeed(
    buckets: Buckets,
    tokenBudget: number,
    trailerNote?: string,
): ComposeResult {
    const charBudget = tokenBudget * TOKEN_CHAR_RATIO;
    const lines: string[] = [];
    const usage = { compacted: 0, user: 0, assistant: 0, files: 0, todos: 0 };

    // Cross-bucket budget reallocation: low-demand buckets cede surplus to
    // high-demand neighbours by priority order.
    const wants = estimateBucketWants(buckets);
    const budgets = allocateBucketBudgets(wants, charBudget);

    lines.push(SEED_SENTINEL);
    lines.push('## 上下文摘要（happy /compact 本地重建）');

    // 1. codex's own compacted history (if any). User messages only.
    if (buckets.lastCompacted?.replacement_history?.length && budgets.compacted > 0) {
        const compactedTexts: string[] = [];
        for (const msg of buckets.lastCompacted.replacement_history) {
            if (msg.role !== 'user') continue;
            const text = extractMessageText(msg.content);
            if (!text || isNoiseUserMessage(text)) continue;
            compactedTexts.push(text);
        }
        if (compactedTexts.length > 0) {
            const packed = packBucket(compactedTexts, budgets.compacted, 0);
            if (packed.lines.length > 0) {
                lines.push('\n### codex 上次成功压缩的历史');
                lines.push(...packed.lines);
                usage.compacted = packed.used;
            }
        }
    }

    // 2. user 指令时序（最新 N 条强制完整保留 + 桶预算装更多旧消息）
    if (buckets.userTexts.length > 0) {
        const packed = packBucket(buckets.userTexts, budgets.user, USER_RECENT_FORCE_KEEP);
        if (packed.lines.length > 0) {
            lines.push(`\n### 用户指令时序（共 ${buckets.userTexts.length} 条，节选 ${packed.lines.length}）`);
            lines.push(...packed.lines);
            usage.user = packed.used;
        }
    }

    // 3. assistant final_answer（按预算装，超长单条做段落感知截断）
    if (buckets.finalAnswers.length > 0 && budgets.assistant > 0) {
        const packed = packBucket(buckets.finalAnswers, budgets.assistant, 0);
        if (packed.lines.length > 0) {
            lines.push(`\n### 我之前给出的关键回答（共 ${buckets.finalAnswers.length} 条，节选 ${packed.lines.length}）`);
            lines.push(...packed.lines);
            usage.assistant = packed.used;
        }
    }

    // 4. 文件路径列表（带 patch +N/-M 摘要）
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
            lines.push(`\n### 涉及的文件路径（共 ${buckets.fileEdits.size}，截取前 ${paths.length}）`);
            for (const p of paths) {
                const summary = buckets.patchSummaries.get(p);
                const tag = summary ? ` (+${summary.plus}/-${summary.minus})` : '';
                lines.push(`- ${p}${tag}`);
            }
            usage.files = pathUsed;
        }
    }

    // 5. TODO（完整 JSON，但若超 todos 桶预算则做单点截断）
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
            lines.push('\n### 当前 TODO 列表');
            lines.push('```json');
            lines.push(todosBlock);
            lines.push('```');
            usage.todos = todosBlock.length;
        }
    }

    // 6. 默认安全 trailer（防虚假健忘）+ 用户额外 trailer
    lines.push('');
    lines.push(DEFAULT_TRAILER);
    if (trailerNote) {
        lines.push('');
        lines.push(trailerNote);
    }

    let seed = lines.join('\n');

    // 7. 全局兜底：如果还是超预算（强制保留 + 默认 trailer 都可能撑爆），head/tail collapse
    if (seed.length > charBudget) {
        const headLen = Math.floor(charBudget * 0.3);
        const tailLen = Math.floor(charBudget * 0.7);
        seed = seed.slice(0, headLen) + '\n\n[...省略中间内容以适配上下文窗口...]\n\n' + seed.slice(-tailLen);
    }

    return { seedText: seed, bucketUsage: usage };
}
