/**
 * Project-level fallback-compact docs: <cwd>/.happy/on-fallback-compact.md.
 *
 * Read fresh from disk on every fallback compaction and appended (wrapped in
 * PROJECT_DOCS sentinels) to the seed, so the user's authoritative project
 * context survives every /compact. The next compaction's seed builder strips
 * the wrapped block (stripProjectDocs) — the doc lives on disk, never in the
 * rollout, so it never accumulates into the compacted bucket.
 *
 * This is intentionally NOT codex's AGENTS.md (injected every turn): it only
 * fires on fallback compaction, the one moment the conversation loses history.
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { logger } from '@/ui/logger';
import { redactHighConfidenceSecrets } from './redactSecrets';

export const FALLBACK_DOC_DIRNAME = '.happy';
export const FALLBACK_DOC_FILENAME = 'on-fallback-compact.md';
export const PROJECT_DOCS_OPEN = '<!--HAPPY-PROJECT-DOCS-v1-->';
export const PROJECT_DOCS_CLOSE = '<!--/HAPPY-PROJECT-DOCS-v1-->';

/**
 * Independent of the seed's 12K-token budget. seed ≤ 48K chars (12K tok × 4),
 * docs ≤ 16K chars (≈4K tok) ⇒ combined ≈ 20K tok ≈ 7.8% of codex's 256K
 * window (same budget framing as compactSeedBuilder DEFAULT_TOKEN_BUDGET).
 * Override via HAPPY_FALLBACK_DOCS_MAX_CHARS — must parse to a finite positive
 * number; a non-positive / non-numeric value falls back to the default instead
 * of silently producing a `slice(0, -n)` tail-chop.
 */
function resolveDefaultDocsMaxChars(): number {
    const n = Number(process.env.HAPPY_FALLBACK_DOCS_MAX_CHARS);
    return Number.isFinite(n) && n > 0 ? n : 16_000;
}
export const DEFAULT_DOCS_MAX_CHARS = resolveDefaultDocsMaxChars();

/**
 * Hard cap on bytes read from disk. Content is char-capped later by
 * truncateAtBoundary, so we never need more than the char budget (×4 for the
 * worst-case UTF-8 expansion) plus headroom. Reading only the head means a
 * mistakenly-huge or runaway file can't blow up memory/CPU before truncation
 * even runs.
 */
const READ_BYTE_LIMIT = DEFAULT_DOCS_MAX_CHARS * 4 + 4096;

/**
 * Break only *complete* sentinel strings so the doc body can't forge a boundary
 * that stripProjectDocs would mis-cut. Bare mentions of the core id in prose
 * are left intact.
 */
function sanitizeSentinels(body: string): string {
    return body
        .split(PROJECT_DOCS_OPEN).join('<!--happy-docs-open(escaped)-->')
        .split(PROJECT_DOCS_CLOSE).join('<!--happy-docs-close(escaped)-->');
}

/**
 * Truncate on a line boundary and balance a dangling code fence so the injected
 * block never leaks an unterminated ``` into the next turn.
 */
function truncateAtBoundary(body: string, maxChars: number): string {
    // Defend against a non-positive / non-finite cap (e.g. a bad env override or
    // caller arg reaching here): fall back to the default so we never run
    // slice(0, -n), which would silently chop the tail instead of the head.
    const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_DOCS_MAX_CHARS;
    if (body.length <= cap) return body;
    let cut = body.slice(0, cap);
    const nl = cut.lastIndexOf('\n');
    if (nl > cap * 0.5) cut = cut.slice(0, nl);
    if ((cut.match(/```/g)?.length ?? 0) % 2 === 1) cut += '\n```';
    return `${cut}\n\n> ⚠️ 项目文档超长，已按行边界截断（保留头部）。`;
}

/**
 * Read at most READ_BYTE_LIMIT bytes from the head of `path`. Using open()+read()
 * (rather than readFile) bounds memory regardless of the on-disk size, and folds
 * ENOENT / EISDIR (a directory at the path) / EACCES / ELOOP into a thrown error
 * the caller turns into ''. A multi-byte char split at the boundary just decodes
 * to U+FFFD, which truncateAtBoundary discards anyway.
 */
async function readDocHead(path: string): Promise<string> {
    const handle = await fsp.open(path, 'r');
    try {
        const buf = Buffer.alloc(READ_BYTE_LIMIT);
        const { bytesRead } = await handle.read(buf, 0, READ_BYTE_LIMIT, 0);
        return buf.subarray(0, bytesRead).toString('utf-8');
    } finally {
        await handle.close();
    }
}

/**
 * Load + render the project doc, or '' if absent/empty/unreadable.
 *
 * Fixed order: bounded head read → strip BOM → trim → sanitize sentinels →
 * high-confidence redact → boundary truncate → wrap. Truncation runs AFTER
 * sanitize so no half-sentinel can appear at the cut. Never throws — every
 * failure folds into '' so the caller (runManualCompact) can append
 * unconditionally.
 */
export async function loadFallbackCompactDocs(
    cwd: string,
    maxChars: number = DEFAULT_DOCS_MAX_CHARS,
): Promise<string> {
    const path = join(cwd, FALLBACK_DOC_DIRNAME, FALLBACK_DOC_FILENAME);
    let raw: string;
    try {
        raw = await readDocHead(path);
    } catch (err) {
        logger.debug(`[projectFallbackDocs] no docs at ${path}: ${(err as Error).message}`);
        return '';
    }

    // Strip a real leading BOM (U+FEFF) by code point, then trim. Detecting the
    // actual char — not a regex over the literal text "﻿" — is the correct
    // contract; .trim() then handles any other leading/trailing whitespace.
    const noBom = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const trimmed = noBom.trim();
    if (!trimmed) return '';

    const body = truncateAtBoundary(
        redactHighConfidenceSecrets(sanitizeSentinels(trimmed)),
        maxChars,
    );
    return [
        '',
        '',
        PROJECT_DOCS_OPEN,
        `## 项目固定上下文（来自 ${FALLBACK_DOC_DIRNAME}/${FALLBACK_DOC_FILENAME}，每次 fallback 压缩自动重注入）`,
        body,
        PROJECT_DOCS_CLOSE,
    ].join('\n');
}

/**
 * Remove every PROJECT_DOCS block (sentinels + content). Tolerant: handles
 * multiple pairs; an unmatched OPEN drops to end-of-string (a corrupted
 * injection is safer dropped than half-kept); no sentinel returns the input
 * unchanged. Used by the seed builder's SEED_SENTINEL branch to break the
 * docs' path into the compacted bucket so they never accumulate.
 */
export function stripProjectDocs(text: string): string {
    if (!text.includes(PROJECT_DOCS_OPEN)) return text;
    let out = text;
    for (;;) {
        const open = out.indexOf(PROJECT_DOCS_OPEN);
        if (open < 0) break;
        const closeFrom = open + PROJECT_DOCS_OPEN.length;
        const close = out.indexOf(PROJECT_DOCS_CLOSE, closeFrom);
        const end = close < 0 ? out.length : close + PROJECT_DOCS_CLOSE.length;
        out = out.slice(0, open) + out.slice(end);
    }
    return out.trimEnd();
}
