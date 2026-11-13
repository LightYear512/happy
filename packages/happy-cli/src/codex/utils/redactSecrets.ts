/**
 * Single source of truth for secret redaction.
 *
 * Two tiers:
 *  - HIGH_CONFIDENCE: keys with a distinctive prefix/structure. Practically
 *    impossible to false-positive on legitimate prose / doc examples.
 *  - GENERALIZED: `name=value` shapes. Higher recall but may clobber a doc
 *    that *explains* `password=...`; only applied to conversation content.
 *
 * Extracted from compactSeedBuilder so both it (full set) and
 * projectFallbackDocs (high-confidence subset) can depend on a leaf module —
 * avoids a circular dependency (compactSeedBuilder already imports
 * projectFallbackDocs for stripProjectDocs). Startup diagnostics also use the
 * full set: recognized credential fields must not depend on password length
 * or a restricted token alphabet.
 */

type Pattern = readonly [RegExp, string];

// High-confidence: a distinctive prefix/structure makes a false positive on
// ordinary prose or documentation examples practically impossible.
export const HIGH_CONFIDENCE_SECRET_PATTERNS: Pattern[] = [
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
];

// Generalized: name=value forms. Higher recall, but may clobber a doc that is
// *explaining* `password=...`. Use only on conversation content, never on the
// user's authoritative project doc.
export const GENERALIZED_SECRET_PATTERNS: Pattern[] = [
    // HTTP Authorization header (bearer / basic)
    [/(Authorization["']?\s*:\s*)(?:Bearer|Basic|Token)\s+\S+/gi, '$1[REDACTED]'],
    // Include quoted Authorization headers, environment prefixes and OAuth fields. Quoted values may
    // contain spaces, punctuation and escapes; unquoted values end at whitespace.
    // Preserve only a complete unquoted marker, never a marker + secret suffix.
    [/\b((?:[a-z][a-z0-9]*[_-])*(?:authorization|api[_-]?key|secret|(?:access|refresh|id|auth)[_-]?token|token|password|passwd|bearer|client[_-]?secret)["']?\s*[:=]\s*)(?!\[REDACTED(?:-[A-Z-]+)?\](?=$|\s))(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)|\S+)/gi, '$1[REDACTED]'],
];

function applyPatterns(text: string, patterns: Pattern[]): string {
    if (!text) return text;
    let result = text;
    for (const [re, replacement] of patterns) {
        result = result.replace(re, replacement);
    }
    return result;
}

/**
 * Full set for conversation content and bounded startup diagnostics. Preserve
 * the established typed markers when subsequently redacting credential fields.
 */
export function redactSensitive(text: string): string {
    return applyPatterns(text, [...HIGH_CONFIDENCE_SECRET_PATTERNS, ...GENERALIZED_SECRET_PATTERNS]);
}

/**
 * High-confidence patterns only — for the user's authoritative project doc.
 * Closes the secret-on-disk gap without the generalized `name=value` rule
 * clobbering legitimate documentation examples.
 */
export function redactHighConfidenceSecrets(text: string): string {
    return applyPatterns(text, HIGH_CONFIDENCE_SECRET_PATTERNS);
}
