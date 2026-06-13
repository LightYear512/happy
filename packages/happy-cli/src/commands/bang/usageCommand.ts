import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { getCurrentCcsProfile, readCcsProfiles, getInstancePath, getCurrentCodexProfile, getCodexInstancePath, readCodexProfiles, type AuthFlavor } from './ccsProfiles';
import { SEPARATOR, codeBlock, parseCodexFlag, rejectCodexFlagInSession, type BangCommandContext, type BangCommandResult } from './types';
import { formatRelativeTime } from './relativeTime';

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
/** Fresh TTL: cache is considered authoritative within this window (no revalidate). */
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_AGE_DISPLAY_MIN_MS = 5 * 60 * 1000; // Hide cache age while it is effectively fresh.
const USAGE_UNAVAILABLE_PERCENT = 95;
/** Stale TTL: beyond fresh but within stale — cached value is still shown with ⏳ marker, and a background revalidate fires. */
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface UsageData {
    five_hour: { utilization: number; resets_at: string } | null;
    seven_day: { utilization: number; resets_at: string } | null;
    seven_day_oauth_apps: { utilization: number; resets_at: string } | null;
    seven_day_opus: { utilization: number; resets_at: string } | null;
    seven_day_sonnet: { utilization: number; resets_at: string } | null;
    seven_day_cowork: { utilization: number; resets_at: string } | null;
    extra_usage: {
        is_enabled: boolean;
        monthly_limit: number | null;
        used_credits: number | null;
        utilization: number | null;
    } | null;
}

interface CachedUsage {
    data: UsageData;
    fetchedAt: number;
}

/** Per-profile usage cache, keyed by CLAUDE_CONFIG_DIR or '~/.claude' */
const cache = new Map<string, CachedUsage>();

/**
 * Resolve the OAuth access token for the current session.
 * Checks CLAUDE_CONFIG_DIR first (CCS profile), then falls back to ~/.claude/.
 * Returns the token, a display label, and a stable cache key.
 */
export function resolveOAuthToken(): { token: string; profileLabel: string; cacheKey: string } | null {
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    logger.debug(`[!usage] resolveOAuthToken: CLAUDE_CONFIG_DIR=${configDir ?? '(unset)'}`);

    // Try CCS profile credentials first
    if (configDir) {
        const token = readOAuthToken(configDir);
        logger.debug(`[!usage] CCS configDir=${configDir}, token found=${!!token}`);
        if (token) {
            const profileName = getCurrentCcsProfile() ?? configDir;
            return { token, profileLabel: profileName, cacheKey: configDir };
        }
    }

    // Fallback to default ~/.claude/
    const defaultDir = join(homedir(), '.claude');
    const token = readOAuthToken(defaultDir);
    logger.debug(`[!usage] Default dir=${defaultDir}, token found=${!!token}`);
    if (token) {
        return { token, profileLabel: 'default', cacheKey: defaultDir };
    }

    return null;
}

function readTokenFromFile(path: string): string | null {
    try {
        const raw = readFileSync(path, 'utf-8');
        const data = JSON.parse(raw);
        return data.claudeAiOauth?.accessToken ?? null;
    } catch {
        return null;
    }
}

/**
 * Read OAuth token from macOS Keychain.
 * Claude Code (newer versions) stores credentials in the system keychain instead of
 * `.credentials.json`. The service name follows the pattern:
 *   "Claude Code-credentials-<sha256(configDir)[0:8]>"
 * For the default ~/.claude instance, the service name is simply "Claude Code-credentials".
 *
 * Results are cached for 60s to avoid repeated subprocess spawns (each ~100ms).
 */
const keychainCache = new Map<string, { token: string | null; ts: number }>();
const KEYCHAIN_CACHE_TTL_MS = 60_000;

function readTokenFromKeychain(configDir: string): string | null {
    if (process.platform !== 'darwin') return null;

    const cached = keychainCache.get(configDir);
    if (cached && Date.now() - cached.ts < KEYCHAIN_CACHE_TTL_MS) return cached.token;

    let token: string | null = null;
    const suffix = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
    const service = `Claude Code-credentials-${suffix}`;
    try {
        const raw = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const data = JSON.parse(raw);
        token = data.claudeAiOauth?.accessToken ?? null;
        if (token) {
            logger.debug(`[!usage] Keychain service=${service}, token found=true`);
        }
    } catch {
        // not found or keychain error
    }
    keychainCache.set(configDir, { token, ts: Date.now() });
    return token;
}

/**
 * Read OAuth token for a given config directory.
 * Tries `.credentials.json` file first, then falls back to macOS Keychain.
 */
export function readOAuthToken(configDir: string): string | null {
    const credPath = join(configDir, '.credentials.json');
    const token = readTokenFromFile(credPath);
    if (token) return token;
    return readTokenFromKeychain(configDir);
}

/**
 * Resolve proxy URL: env vars first, then Claude settings.json (CCS instance or default).
 * Claude Code injects HTTPS_PROXY via settings.json env, but the daemon session process
 * may not have these env vars. Reading settings.json mirrors Claude's own proxy behavior.
 */
function resolveProxy(): string | null {
    const fromEnv = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    if (fromEnv) return fromEnv;

    // Read proxy from Claude settings.json (same source Claude Code uses)
    const candidates = [
        process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'settings.json') : null,
        join(homedir(), '.claude', 'settings.json'),
    ].filter(Boolean) as string[];

    for (const settingsPath of candidates) {
        try {
            const raw = readFileSync(settingsPath, 'utf-8');
            const settings = JSON.parse(raw);
            const proxy = settings.env?.HTTPS_PROXY || settings.env?.HTTP_PROXY;
            if (proxy) return proxy;
        } catch {
            // File doesn't exist or invalid JSON, try next
        }
    }

    return null;
}

/**
 * Fetch usage data from the Anthropic OAuth usage API.
 * Uses undici with ProxyAgent when a proxy is configured.
 * Direct connections from geo-restricted IPs get Cloudflare 403,
 * so we mirror Claude's own proxy settings from settings.json.
 */
export async function fetchUsage(token: string, debugLabel: string): Promise<UsageData> {
    const tokenPrefix = token.substring(0, 15) + '...';
    const proxy = resolveProxy();
    logger.debug(`[!usage] Calling ${USAGE_API_URL} token=${tokenPrefix} label=${debugLabel} proxy=${proxy ?? '(none)'}`);

    const fetchOptions: Parameters<typeof undiciFetch>[1] = {
        headers: {
            'Authorization': `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(5_000),
    };

    if (proxy) {
        (fetchOptions as Record<string, unknown>).dispatcher = new ProxyAgent(proxy);
    }

    const response = await undiciFetch(USAGE_API_URL, fetchOptions);

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        logger.debug(`[!usage] API error: ${response.status} ${text}`);
        if (response.status === 401) {
            throw new Error('OAuth 令牌已过期或无效。请在 cc 中发送任意消息以刷新令牌后重试，若仍失败请 !login 重新登录。');
        }
        if (response.status === 403) {
            throw new Error('请求被拒绝 (403)，请尝试重新登录。');
        }
        if (response.status === 429) {
            throw new Error('Anthropic API 限流，请稍后再试。');
        }
        throw new Error(`API 返回 ${response.status}: ${text}`);
    }

    return await response.json() as UsageData;
}

/**
 * Format a reset timestamp into a human-readable relative string.
 */
export function formatResetTime(resetsAt: string): string {
    const resetDate = new Date(resetsAt);
    const now = new Date();
    const diffMs = resetDate.getTime() - now.getTime();

    if (diffMs <= 0) return '即将重置';

    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${diffMin} 分钟`;

    const diffHours = Math.floor(diffMin / 60);
    const remainMin = diffMin % 60;
    if (diffHours < 24) return remainMin > 0 ? `${diffHours} 小时 ${remainMin} 分钟` : `${diffHours} 小时`;

    const diffDays = Math.floor(diffHours / 24);
    const remainHours = diffHours % 24;
    return remainHours > 0 ? `${diffDays} 天 ${remainHours} 小时` : `${diffDays} 天`;
}

/**
 * Build a usage bar visualization.
 */
function usageBar(utilization: number): string {
    const total = 15;
    const filled = Math.max(0, Math.min(total, Math.round(utilization / 100 * total)));
    const bar = '█'.repeat(filled) + '░'.repeat(total - filled);
    return `[${bar}] ${utilization.toFixed(0)}%`;
}

function formatClockTime(resetsAt: string): string {
    const date = new Date(resetsAt);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatAvailability(resetsAt: string | null | undefined): string {
    if (!resetsAt) return '重置时间未知';
    const relative = formatResetTime(resetsAt);
    const clock = formatClockTime(resetsAt);
    return clock ? `${relative}后可用｜${clock}` : `${relative}后可用`;
}

function formatClaudeUsageSummary(data: UsageData): string | null {
    const parts: string[] = [];
    if (data.five_hour) {
        const fiveHour = `5h: ${data.five_hour.utilization.toFixed(0)}%`;
        parts.push(data.five_hour.utilization >= USAGE_UNAVAILABLE_PERCENT
            ? `${fiveHour}｜${formatAvailability(data.five_hour.resets_at)}`
            : fiveHour);
    }
    if (data.seven_day) {
        const sevenDay = `7d: ${data.seven_day.utilization.toFixed(0)}%`;
        parts.push(data.seven_day.utilization >= USAGE_UNAVAILABLE_PERCENT
            ? `${sevenDay}｜${formatAvailability(data.seven_day.resets_at)}`
            : sevenDay);
    }
    return parts.length > 0 ? parts.join('｜') : null;
}

function formatCodexUsageSummary(data: CodexUsageData): string | null {
    const parts: string[] = [];
    if (data.primaryWindow) {
        const fiveHour = `5h: ${data.primaryWindow.usedPercent.toFixed(0)}%`;
        const resetAt = data.primaryWindow.resetAt ? new Date(data.primaryWindow.resetAt * 1000).toISOString() : null;
        parts.push(data.primaryWindow.usedPercent >= USAGE_UNAVAILABLE_PERCENT
            ? `${fiveHour}｜${formatAvailability(resetAt)}`
            : fiveHour);
    }
    if (data.secondaryWindow) {
        const sevenDay = `7d: ${data.secondaryWindow.usedPercent.toFixed(0)}%`;
        const resetAt = data.secondaryWindow.resetAt ? new Date(data.secondaryWindow.resetAt * 1000).toISOString() : null;
        parts.push(data.secondaryWindow.usedPercent >= USAGE_UNAVAILABLE_PERCENT
            ? `${sevenDay}｜${formatAvailability(resetAt)}`
            : sevenDay);
    }
    return parts.length > 0 ? parts.join('｜') : null;
}

function isClaudeFiveHourFull(data: UsageData): boolean {
    return (data.five_hour?.utilization ?? 0) >= USAGE_UNAVAILABLE_PERCENT;
}

function isCodexFiveHourFull(data: CodexUsageData): boolean {
    return (data.primaryWindow?.usedPercent ?? 0) >= USAGE_UNAVAILABLE_PERCENT;
}

function isClaudeSevenDayFull(data: UsageData): boolean {
    return (data.seven_day?.utilization ?? 0) >= USAGE_UNAVAILABLE_PERCENT;
}

function isCodexSevenDayFull(data: CodexUsageData): boolean {
    return (data.secondaryWindow?.usedPercent ?? 0) >= USAGE_UNAVAILABLE_PERCENT;
}

/**
 * Get a one-line usage summary from cache for a given config dir (used by !auth after switch).
 * Returns null if no cached data is available.
 */
export function getCachedUsageSummary(cacheKey: string): string | null {
    ensureHydrated();
    const cached = cache.get(cacheKey);
    if (!cached || (Date.now() - cached.fetchedAt) >= CACHE_TTL_MS) return null;
    return formatClaudeUsageSummary(cached.data);
}

/** Read a profile usage summary from the shared file-backed cache without network I/O. */
export function getCachedProfileUsageEntry(profileName: string, flavor: AuthFlavor): ProfileUsageEntry | null {
    ensureHydrated();
    const isCodex = flavor === 'codex';
    const cacheKey = isCodex ? getCodexInstancePath(profileName) : getInstancePath(profileName);
    const cached = isCodex ? codexCache.get(cacheKey) : cache.get(cacheKey);
    if (!cached) return null;

    const age = Date.now() - cached.fetchedAt;
    if (age >= STALE_TTL_MS) return null;

    return isCodex
        ? makeCodexEntry((cached as CachedCodexUsage).data, cached.fetchedAt, age >= CACHE_TTL_MS)
        : makeClaudeEntry((cached as CachedUsage).data, cached.fetchedAt, age >= CACHE_TTL_MS);
}

/** Usage summary result for !auth profile list. */
export interface ProfileUsageEntry {
    /** Formatted one-line summary if available (may come from stale cache). */
    summary: string | null;
    /** 5h utilization percentage for compact account menus. */
    fiveHourPercent: number | null;
    /** 5h reset timestamp, ISO string, for compact account menus. */
    fiveHourResetAt: string | null;
    /** 7d utilization percentage for compact account menus. */
    sevenDayPercent: number | null;
    /** 7d reset timestamp, ISO string, for compact account menus. */
    sevenDayResetAt: string | null;
    /** True when the 5h window is at or above 100%. */
    full: boolean;
    /** True when the 7d window is at or above 100%. */
    sevenDayFull: boolean;
    /** True when the fetch failed because the OAuth token is expired/invalid (401/403). */
    authExpired: boolean;
    /** True when the summary was served from the stale-TTL window (fresh expired but still within STALE_TTL_MS). */
    stale: boolean;
    /** Unix ms when the underlying data was fetched, or null if no data. */
    cachedAt: number | null;
}

function makeClaudeEntry(data: UsageData, cachedAt: number, stale = false, authExpired = false): ProfileUsageEntry {
    return {
        summary: formatClaudeUsageSummary(data),
        fiveHourPercent: data.five_hour?.utilization ?? null,
        fiveHourResetAt: data.five_hour?.resets_at ?? null,
        sevenDayPercent: data.seven_day?.utilization ?? null,
        sevenDayResetAt: data.seven_day?.resets_at ?? null,
        full: isClaudeFiveHourFull(data),
        sevenDayFull: isClaudeSevenDayFull(data),
        authExpired,
        stale,
        cachedAt,
    };
}

function makeCodexEntry(data: CodexUsageData, cachedAt: number, stale = false, authExpired = false): ProfileUsageEntry {
    const resetAt = data.primaryWindow?.resetAt ? new Date(data.primaryWindow.resetAt * 1000).toISOString() : null;
    const sevenDayResetAt = data.secondaryWindow?.resetAt ? new Date(data.secondaryWindow.resetAt * 1000).toISOString() : null;
    return {
        summary: formatCodexUsageSummary(data),
        fiveHourPercent: data.primaryWindow?.usedPercent ?? null,
        fiveHourResetAt: resetAt,
        sevenDayPercent: data.secondaryWindow?.usedPercent ?? null,
        sevenDayResetAt,
        full: isCodexFiveHourFull(data),
        sevenDayFull: isCodexSevenDayFull(data),
        authExpired,
        stale,
        cachedAt,
    };
}

/** Detect whether a thrown fetch error is an auth-expired error (401/403). */
function isAuthExpiredError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.message.includes('令牌已过期') || err.message.includes('令牌已过期或无效');
}

/** In-flight background revalidations (dedupe by cache key). */
const inflightRevalidate = new Set<string>();

/** Fire-and-forget background refresh for a Claude profile whose cache is stale. */
function backgroundRevalidateClaude(instancePath: string, profileName: string): void {
    if (inflightRevalidate.has(`claude:${instancePath}`)) return;
    inflightRevalidate.add(`claude:${instancePath}`);
    void (async () => {
        try {
            const token = readOAuthToken(instancePath);
            if (!token) return;
            const data = await Promise.race([
                fetchUsage(token, profileName),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
            ]);
            setClaudeCache(instancePath, { data, fetchedAt: Date.now() });
            logger.debug(`[!usage] background revalidate succeeded for ${profileName}`);
        } catch (err) {
            logger.debug(`[!usage] background revalidate failed for ${profileName}:`, err);
        } finally {
            inflightRevalidate.delete(`claude:${instancePath}`);
        }
    })();
}

/** Fire-and-forget background refresh for a Codex profile whose cache is stale. */
function backgroundRevalidateCodex(codexHome: string, profileName: string): void {
    if (inflightRevalidate.has(`codex:${codexHome}`)) return;
    inflightRevalidate.add(`codex:${codexHome}`);
    void (async () => {
        try {
            const token = readCodexAccessToken(codexHome);
            if (!token) return;
            const data = await Promise.race([
                fetchCodexUsage(token, profileName),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
            ]);
            setCodexCache(codexHome, { data, fetchedAt: Date.now() });
            logger.debug(`[!usage] codex background revalidate succeeded for ${profileName}`);
        } catch (err) {
            logger.debug(`[!usage] codex background revalidate failed for ${profileName}:`, err);
        } finally {
            inflightRevalidate.delete(`codex:${codexHome}`);
        }
    })();
}

/**
 * Fetch a one-line usage summary for a profile, respecting cache.
 *
 * Cache strategy (stale-while-revalidate):
 *   - Fresh hit (age < CACHE_TTL_MS): return cached summary with `stale=false`.
 *   - Stale hit (CACHE_TTL_MS ≤ age < STALE_TTL_MS): return cached summary with
 *     `stale=true`, trigger a fire-and-forget background revalidate so the next
 *     call sees fresh data. If revalidate fails (e.g. token expired), the same
 *     stale value keeps serving until STALE_TTL_MS elapses.
 *   - Miss / expired beyond stale: synchronous network fetch (5s timeout).
 *
 * Returns `{ summary, authExpired, stale, cachedAt }` so callers can distinguish
 * "no data yet" from "token expired and needs refresh via any cc message", and
 * render a "⏳ N 分钟前" marker when the data is stale.
 */
export async function fetchProfileUsageSummary(profileName: string, flavor: AuthFlavor): Promise<ProfileUsageEntry> {
    ensureHydrated();
    const isCodex = flavor === 'codex';
    const cacheKey = isCodex ? getCodexInstancePath(profileName) : getInstancePath(profileName);
    try {
        if (isCodex) {
            const cached = codexCache.get(cacheKey);
            const age = cached ? Date.now() - cached.fetchedAt : Infinity;
            if (cached && age < CACHE_TTL_MS) {
                return makeCodexEntry(cached.data, cached.fetchedAt);
            }
            if (cached && age < STALE_TTL_MS) {
                backgroundRevalidateCodex(cacheKey, profileName);
                return makeCodexEntry(cached.data, cached.fetchedAt, true);
            }
            const token = readCodexAccessToken(cacheKey);
            if (!token) return { summary: null, fiveHourPercent: null, fiveHourResetAt: null, sevenDayPercent: null, sevenDayResetAt: null, full: false, sevenDayFull: false, authExpired: false, stale: false, cachedAt: null };
            const data = await Promise.race([
                fetchCodexUsage(token, profileName),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
            ]);
            const now = Date.now();
            setCodexCache(cacheKey, { data, fetchedAt: now });
            return makeCodexEntry(data, now);
        }

        // Claude
        const cached = cache.get(cacheKey);
        const age = cached ? Date.now() - cached.fetchedAt : Infinity;
        if (cached && age < CACHE_TTL_MS) {
            return makeClaudeEntry(cached.data, cached.fetchedAt);
        }
        if (cached && age < STALE_TTL_MS) {
            backgroundRevalidateClaude(cacheKey, profileName);
            return makeClaudeEntry(cached.data, cached.fetchedAt, true);
        }
        const token = readOAuthToken(cacheKey);
        if (!token) return { summary: null, fiveHourPercent: null, fiveHourResetAt: null, sevenDayPercent: null, sevenDayResetAt: null, full: false, sevenDayFull: false, authExpired: false, stale: false, cachedAt: null };
        const data = await Promise.race([
            fetchUsage(token, profileName),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        const now = Date.now();
        setClaudeCache(cacheKey, { data, fetchedAt: now });
        return makeClaudeEntry(data, now);
    } catch (err) {
        logger.debug(`[!usage] fetchProfileUsageSummary failed for ${profileName}:`, err);
        // Fetch failed → fall back to any cached value still within stale window, so users
        // keep seeing their last-known usage alongside the 🔒 / 💡 refresh hint.
        const authExpired = isAuthExpiredError(err);
        const cached = isCodex ? codexCache.get(cacheKey) : cache.get(cacheKey);
        if (cached && (Date.now() - cached.fetchedAt) < STALE_TTL_MS) {
            return isCodex
                ? makeCodexEntry((cached as CachedCodexUsage).data, cached.fetchedAt, true, authExpired)
                : makeClaudeEntry((cached as CachedUsage).data, cached.fetchedAt, true, authExpired);
        }
        return { summary: null, fiveHourPercent: null, fiveHourResetAt: null, sevenDayPercent: null, sevenDayResetAt: null, full: false, sevenDayFull: false, authExpired, stale: false, cachedAt: null };
    }
}

/**
 * Format the usage data into a readable, centered message.
 */
function formatDetailedDataAge(cachedAt: number): string | null {
    const ageMs = Date.now() - cachedAt;
    if (ageMs < CACHE_AGE_DISPLAY_MIN_MS) return null;
    if (ageMs < CACHE_TTL_MS) {
        const remainMin = Math.ceil((CACHE_TTL_MS - ageMs) / 60000);
        return `ℹ️ 数据获取于 ${formatRelativeTime(cachedAt)}（${remainMin} 分钟内复用缓存）`;
    }
    return `ℹ️ 旧缓存获取于 ${formatRelativeTime(cachedAt)}（已超过 15 分钟）`;
}

export function formatUsage(data: UsageData, profileLabel: string, cachedAt: number): string[] {
    const messages: string[] = [`📊 用量 — ${profileLabel}`];

    // 5-hour window
    if (data.five_hour) {
        messages.push([
            '⏱ 5 小时窗口',
            usageBar(data.five_hour.utilization),
            `${formatResetTime(data.five_hour.resets_at)} 后重置`,
        ].join('\n'));
    }

    // 7-day overall
    if (data.seven_day) {
        messages.push([
            '📅 7 天总量',
            usageBar(data.seven_day.utilization),
            `${formatResetTime(data.seven_day.resets_at)} 后重置`,
        ].join('\n'));
    }

    // 7-day per-model breakdowns (only show if present)
    const modelBreakdowns: Array<{ label: string; entry: { utilization: number; resets_at: string } | null }> = [
        { label: '🔮 Opus 7天', entry: data.seven_day_opus },
        { label: '✨ Sonnet 7天', entry: data.seven_day_sonnet },
    ];

    for (const { label, entry } of modelBreakdowns) {
        if (entry) {
            messages.push(`${label}\n${usageBar(entry.utilization)}`);
        }
    }

    // Extra usage
    if (data.extra_usage?.is_enabled) {
        const parts = ['💰 额外用量'];
        if (data.extra_usage.utilization !== null) {
            parts.push(usageBar(data.extra_usage.utilization));
        }
        if (data.extra_usage.used_credits !== null && data.extra_usage.monthly_limit !== null) {
            parts.push(`$${data.extra_usage.used_credits.toFixed(2)} / $${data.extra_usage.monthly_limit.toFixed(2)}`);
        }
        messages.push(parts.join('\n'));
    }

    const dataAge = formatDetailedDataAge(cachedAt);
    if (dataAge) messages.push(dataAge);

    return messages;
}

/**
 * Resolve OAuth token for a specific CCS profile by name.
 */
function resolveOAuthTokenForProfile(profileName: string): { token: string; profileLabel: string; cacheKey: string } | null {
    const instancePath = getInstancePath(profileName);
    const token = readOAuthToken(instancePath);
    if (token) {
        return { token, profileLabel: profileName, cacheKey: instancePath };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Codex usage (OpenAI wham/usage API)
// ---------------------------------------------------------------------------

const CODEX_USAGE_API_URL = 'https://chatgpt.com/backend-api/wham/usage';

interface CodexUsageData {
    planType?: string;
    /** 5-hour primary window */
    primaryWindow?: { usedPercent: number; resetAt: number };
    /** 7-day secondary window */
    secondaryWindow?: { usedPercent: number; resetAt: number };
    /** Code review rate limit (null when not available) */
    codeReviewWindow?: { usedPercent: number; resetAt: number };
}

interface CachedCodexUsage {
    data: CodexUsageData;
    fetchedAt: number;
}

const codexCache = new Map<string, CachedCodexUsage>();

// ---------------------------------------------------------------------------
// Disk persistence (file-backed cache for cross-session consistency)
// ---------------------------------------------------------------------------
//
// Both `cache` (Claude) and `codexCache` (Codex) are mirrored to a single
// JSON file under `$HAPPY_HOME_DIR/usage-cache.json`. Usage commands are
// low-frequency, so every read reloads this file and every write immediately
// performs a merge + atomic rename. This keeps console and session views aligned
// across separate Happy processes.
//
// Format:
// {
//   "version": 1,
//   "claude": { "<instancePath>": { "data": {...}, "fetchedAt": 1234567890 } },
//   "codex":  { "<codexHome>":    { "data": {...}, "fetchedAt": 1234567890 } }
// }

const USAGE_CACHE_FILE = join(configuration.happyHomeDir, 'usage-cache.json');
const USAGE_CACHE_LOCK_FILE = `${USAGE_CACHE_FILE}.lock`;
const USAGE_CACHE_VERSION = 1;

type UsageCachePayload = {
    version: number;
    claude: Record<string, CachedUsage>;
    codex: Record<string, CachedCodexUsage>;
};

function emptyUsageCachePayload(): UsageCachePayload {
    return { version: USAGE_CACHE_VERSION, claude: {}, codex: {} };
}

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readUsageCachePayload(): UsageCachePayload {
    try {
        const raw = readFileSync(USAGE_CACHE_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as {
            version?: number;
            claude?: Record<string, CachedUsage>;
            codex?: Record<string, CachedCodexUsage>;
        };
        if (parsed.version !== USAGE_CACHE_VERSION) {
            logger.debug(`[!usage] usage-cache version mismatch (${parsed.version} vs ${USAGE_CACHE_VERSION}), ignoring`);
            return emptyUsageCachePayload();
        }
        return {
            version: USAGE_CACHE_VERSION,
            claude: parsed.claude ?? {},
            codex: parsed.codex ?? {},
        };
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            logger.debug('[!usage] failed to read usage-cache:', err);
        }
        return emptyUsageCachePayload();
    }
}

function loadUsageCacheIntoMemory(payload: UsageCachePayload): void {
    cache.clear();
    codexCache.clear();
    const now = Date.now();
    for (const [key, entry] of Object.entries(payload.claude)) {
        if (!entry || typeof entry.fetchedAt !== 'number') continue;
        if ((now - entry.fetchedAt) >= STALE_TTL_MS) continue;
        cache.set(key, entry);
    }
    for (const [key, entry] of Object.entries(payload.codex)) {
        if (!entry || typeof entry.fetchedAt !== 'number') continue;
        if ((now - entry.fetchedAt) >= STALE_TTL_MS) continue;
        codexCache.set(key, entry);
    }
}

function ensureHydrated(): void {
    loadUsageCacheIntoMemory(readUsageCachePayload());
}

function writeUsageCachePayload(payload: UsageCachePayload): void {
    mkdirSync(configuration.happyHomeDir, { recursive: true });
    const tmp = `${USAGE_CACHE_FILE}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    renameSync(tmp, USAGE_CACHE_FILE);
}

function withUsageCacheLock<T>(operation: () => T): T {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        let fd: number | null = null;
        try {
            fd = openSync(USAGE_CACHE_LOCK_FILE, 'wx');
            try {
                return operation();
            } finally {
                closeSync(fd);
                unlinkSync(USAGE_CACHE_LOCK_FILE);
            }
        } catch (err) {
            if (fd !== null) {
                try { closeSync(fd); } catch { /* ignore */ }
            }
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code !== 'EEXIST') throw err;
            try {
                const stat = statSync(USAGE_CACHE_LOCK_FILE);
                if (Date.now() - stat.mtimeMs > 10_000) unlinkSync(USAGE_CACHE_LOCK_FILE);
            } catch {
                // Another process may have released the lock between checks.
            }
            sleepSync(50);
        }
    }
    logger.debug('[!usage] usage-cache lock timeout, writing without lock');
    return operation();
}

function writeUsageEntry(section: 'claude' | 'codex', key: string, entry: CachedUsage | CachedCodexUsage): void {
    withUsageCacheLock(() => {
        const payload = readUsageCachePayload();
        if (section === 'claude') {
            payload.claude[key] = entry as CachedUsage;
        } else {
            payload.codex[key] = entry as CachedCodexUsage;
        }
        const now = Date.now();
        for (const [cacheKey, cached] of Object.entries(payload.claude)) {
            if (!cached || typeof cached.fetchedAt !== 'number' || (now - cached.fetchedAt) >= STALE_TTL_MS) {
                delete payload.claude[cacheKey];
            }
        }
        for (const [cacheKey, cached] of Object.entries(payload.codex)) {
            if (!cached || typeof cached.fetchedAt !== 'number' || (now - cached.fetchedAt) >= STALE_TTL_MS) {
                delete payload.codex[cacheKey];
            }
        }
        writeUsageCachePayload(payload);
        loadUsageCacheIntoMemory(payload);
    });
}

/** Write to the Claude usage cache and immediately merge it to disk. */
function setClaudeCache(key: string, entry: CachedUsage): void {
    cache.set(key, entry);
    writeUsageEntry('claude', key, entry);
}

/** Write to the Codex usage cache and immediately merge it to disk. */
function setCodexCache(key: string, entry: CachedCodexUsage): void {
    codexCache.set(key, entry);
    writeUsageEntry('codex', key, entry);
}

/** Read access_token from a codex auth.json file. */
function readCodexAccessToken(codexHome: string): string | null {
    const authPath = join(codexHome, 'auth.json');
    try {
        const raw = readFileSync(authPath, 'utf-8');
        const data = JSON.parse(raw);
        return data?.tokens?.access_token ?? null;
    } catch {
        return null;
    }
}

/** Resolve codex auth token for the current session or a named profile. */
function resolveCodexToken(profileName?: string): { token: string; profileLabel: string; cacheKey: string } | null {
    if (profileName) {
        const codexHome = getCodexInstancePath(profileName);
        const token = readCodexAccessToken(codexHome);
        if (token) return { token, profileLabel: profileName, cacheKey: codexHome };
        return null;
    }

    // Current session: only resolve via CODEX_HOME (no fallback to ~/.codex)
    const codexHome = process.env.CODEX_HOME;
    if (!codexHome) return null;

    const token = readCodexAccessToken(codexHome);
    if (token) {
        const label = getCurrentCodexProfile() ?? 'default';
        return { token, profileLabel: label, cacheKey: codexHome };
    }
    return null;
}

/** Fetch usage from OpenAI wham/usage API. */
async function fetchCodexUsage(token: string, debugLabel: string): Promise<CodexUsageData> {
    const proxy = resolveProxy();
    logger.debug(`[!usage:codex] Calling ${CODEX_USAGE_API_URL} label=${debugLabel} proxy=${proxy ?? '(none)'}`);

    const fetchOptions: Parameters<typeof undiciFetch>[1] = {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5_000),
    };
    if (proxy) {
        (fetchOptions as Record<string, unknown>).dispatcher = new ProxyAgent(proxy);
    }

    const response = await undiciFetch(CODEX_USAGE_API_URL, fetchOptions);
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        logger.debug(`[!usage:codex] API error: ${response.status} ${text}`);
        if (response.status === 401) throw new Error('Codex OAuth 令牌已过期。请 !login 重新登录。');
        if (response.status === 403) throw new Error('无 Codex 访问权限或请求被拒绝 (403)。');
        throw new Error(`API 返回 ${response.status}: ${text}`);
    }

    const raw = await response.json() as Record<string, unknown>;

    // Parse wham/usage response — actual shape:
    // { plan_type, rate_limit: { primary_window: { used_percent, reset_at }, secondary_window: {...} }, code_review_rate_limit, ... }
    const result: CodexUsageData = { planType: raw.plan_type as string | undefined };
    const rateLimit = raw.rate_limit as Record<string, { used_percent?: number; reset_at?: number }> | undefined;
    if (rateLimit?.primary_window) {
        result.primaryWindow = {
            usedPercent: rateLimit.primary_window.used_percent ?? 0,
            resetAt: rateLimit.primary_window.reset_at ?? 0,
        };
    }
    if (rateLimit?.secondary_window) {
        result.secondaryWindow = {
            usedPercent: rateLimit.secondary_window.used_percent ?? 0,
            resetAt: rateLimit.secondary_window.reset_at ?? 0,
        };
    }
    const codeReview = raw.code_review_rate_limit as { used_percent?: number; reset_at?: number } | null;
    if (codeReview) {
        result.codeReviewWindow = {
            usedPercent: codeReview.used_percent ?? 0,
            resetAt: codeReview.reset_at ?? 0,
        };
    }
    return result;
}

/** Convert a Unix timestamp (seconds) to an ISO string for formatResetTime. */
function unixToIso(ts: number): string {
    return new Date(ts * 1000).toISOString();
}

/** Format codex usage data into readable messages. */
function formatCodexUsage(data: CodexUsageData, profileLabel: string, cachedAt: number): string[] {
    const planLabel = data.planType ? ` (${data.planType})` : '';
    const messages: string[] = [`📊 Codex 用量 — ${profileLabel}${planLabel}`];

    if (data.primaryWindow) {
        messages.push([
            '⏱ 5 小时窗口',
            usageBar(data.primaryWindow.usedPercent),
            data.primaryWindow.resetAt ? `${formatResetTime(unixToIso(data.primaryWindow.resetAt))} 后重置` : '',
        ].filter(Boolean).join('\n'));
    }

    if (data.secondaryWindow) {
        messages.push([
            '📅 周限额',
            usageBar(data.secondaryWindow.usedPercent),
            data.secondaryWindow.resetAt ? `${formatResetTime(unixToIso(data.secondaryWindow.resetAt))} 后重置` : '',
        ].filter(Boolean).join('\n'));
    }

    if (data.codeReviewWindow) {
        messages.push([
            '🔍 Code Review',
            usageBar(data.codeReviewWindow.usedPercent),
            data.codeReviewWindow.resetAt ? `${formatResetTime(unixToIso(data.codeReviewWindow.resetAt))} 后重置` : '',
        ].filter(Boolean).join('\n'));
    }

    if (!data.primaryWindow && !data.secondaryWindow && !data.codeReviewWindow) {
        messages.push('暂无用量数据');
    }

    const dataAge = formatDetailedDataAge(cachedAt);
    if (dataAge) messages.push(dataAge);

    return messages;
}

function formatCompactResetTime(resetsAt: string | null): string | null {
    if (!resetsAt) return null;
    const resetDate = new Date(resetsAt);
    const diffMs = resetDate.getTime() - Date.now();
    if (!Number.isFinite(diffMs)) return null;
    const totalMin = Math.max(0, Math.ceil(diffMs / 60000));
    const hours = Math.floor(totalMin / 60);
    const minutes = totalMin % 60;
    return `下${hours}:${minutes.toString().padStart(2, '0')}时`;
}

function formatCompactSevenDayResetTime(resetsAt: string | null): string | null {
    if (!resetsAt) return null;
    const resetDate = new Date(resetsAt);
    const diffMs = resetDate.getTime() - Date.now();
    if (!Number.isFinite(diffMs)) return null;
    const totalHours = Math.max(0, Math.floor(diffMs / 3600000));
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return `${days}D:${hours}h`;
}

function formatCompactCacheAge(cachedAt: number): string {
    const ageMin = Math.max(0, Math.floor((Date.now() - cachedAt) / 60000));
    if (ageMin < 60) return `${ageMin}m`;
    const ageHours = Math.floor(ageMin / 60);
    if (ageHours < 24) return `${ageHours}h`;
    return `${Math.floor(ageHours / 24)}d`;
}

function formatCompactDataAge(entry: ProfileUsageEntry): string | null {
    if (!entry.cachedAt) return null;
    if (Date.now() - entry.cachedAt < CACHE_AGE_DISPLAY_MIN_MS) return null;
    return `${entry.stale ? '缓' : '取'}${formatCompactCacheAge(entry.cachedAt)}`;
}

function formatCompactProfileUsage(entry: ProfileUsageEntry | null): string[] {
    if (!entry) return ['用量未知'];
    const parts: string[] = [];
    if (entry.fiveHourPercent != null) {
        parts.push(`5h:${entry.fiveHourPercent.toFixed(0)}%`);
        if (entry.full) {
            const resetText = formatCompactResetTime(entry.fiveHourResetAt);
            if (resetText) parts.push(resetText);
        }
    }
    if (entry.sevenDayPercent != null) {
        parts.push(`7d:${entry.sevenDayPercent.toFixed(0)}%`);
        const resetText = formatCompactSevenDayResetTime(entry.sevenDayResetAt);
        if (resetText) parts.push(resetText);
    }
    if (parts.length === 0 && entry.summary) parts.push(entry.summary);
    const dataAge = formatCompactDataAge(entry);
    if (dataAge) parts.push(dataAge);
    return parts.length > 0 ? parts : ['用量未知'];
}

function isGuessAvailableAfterReset(entry: ProfileUsageEntry | null): boolean {
    if (!entry || (!entry.full && !entry.sevenDayFull)) return false;
    return !isFiveHourBlocked(entry) && !isSevenDayBlocked(entry);
}

const DEFAULT_PROFILE_MARKER = '💚';
const DEFAULT_HIGH_USAGE_PROFILE_MARKER = '💔';
const USABLE_PROFILE_MARKER = '🔵';
const UNAVAILABLE_PROFILE_MARKER = '🚫';
const GUESS_AVAILABLE_PROFILE_MARKER = '🟣';
const DEFAULT_HIGH_USAGE_PERCENT = 85;
const UNAVAILABLE_DAY_MARKERS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'] as const;

function usageProfileUnavailable(entry: ProfileUsageEntry | null): boolean {
    return !entry || !!entry.authExpired || isFiveHourBlocked(entry) || isSevenDayBlocked(entry);
}

function defaultProfileHighUsage(entry: ProfileUsageEntry | null): boolean {
    return (entry?.fiveHourPercent != null && entry.fiveHourPercent > DEFAULT_HIGH_USAGE_PERCENT)
        || (entry?.sevenDayPercent != null && entry.sevenDayPercent > DEFAULT_HIGH_USAGE_PERCENT);
}

function usageProfileMarker(entry: ProfileUsageEntry | null, isDefault = false): string {
    if (isDefault && defaultProfileHighUsage(entry)) return DEFAULT_HIGH_USAGE_PROFILE_MARKER;
    if (usageProfileUnavailable(entry)) return UNAVAILABLE_PROFILE_MARKER;
    if (isGuessAvailableAfterReset(entry)) return GUESS_AVAILABLE_PROFILE_MARKER;
    if (isDefault) return DEFAULT_PROFILE_MARKER;
    return USABLE_PROFILE_MARKER;
}

function usageAvailablePercent(entry: ProfileUsageEntry | null): number | null {
    if (entry?.fiveHourPercent == null) return null;
    return Math.max(0, 100 - entry.fiveHourPercent);
}

function resetPassed(resetsAt: string | null | undefined): boolean {
    if (!resetsAt) return false;
    const resetAt = new Date(resetsAt).getTime();
    return Number.isFinite(resetAt) && resetAt <= Date.now();
}

function isFiveHourBlocked(entry: ProfileUsageEntry): boolean {
    return entry.full && !resetPassed(entry.fiveHourResetAt);
}

function isSevenDayBlocked(entry: ProfileUsageEntry): boolean {
    return entry.sevenDayFull && !resetPassed(entry.sevenDayResetAt);
}

function resetDelayMs(resetsAt: string | null | undefined): number | null {
    if (!resetsAt) return null;
    const resetAt = new Date(resetsAt).getTime();
    if (!Number.isFinite(resetAt)) return null;
    return Math.max(0, resetAt - Date.now());
}

function usageResetDelayMs(entry: ProfileUsageEntry | null): number | null {
    if (!entry) return null;
    const delays: number[] = [];
    if (entry.full && !resetPassed(entry.fiveHourResetAt)) {
        const delay = resetDelayMs(entry.fiveHourResetAt);
        if (delay == null) return null;
        delays.push(delay);
    }
    if (entry.sevenDayFull && !resetPassed(entry.sevenDayResetAt)) {
        const delay = resetDelayMs(entry.sevenDayResetAt);
        if (delay == null) return null;
        delays.push(delay);
    }
    return delays.length > 0 ? Math.max(...delays) : null;
}

function unavailableDayMarker(delayMs: number | null): string | null {
    if (delayMs == null) return null;
    const days = Math.max(0, Math.min(5, Math.floor(delayMs / 86400000)));
    return UNAVAILABLE_DAY_MARKERS[days];
}

function usageUnavailablePrefix(entry: ProfileUsageEntry | null): string | null {
    const marker = unavailableDayMarker(usageResetDelayMs(entry));
    if (!marker || !entry) return marker;
    if (isSevenDayBlocked(entry)) return `${UNAVAILABLE_PROFILE_MARKER} ${marker}`;
    if (isFiveHourBlocked(entry)) return marker;
    return marker;
}

function usageSort(entry: ProfileUsageEntry | null): { sortGroup: number; sortValue: number } {
    if (!usageProfileUnavailable(entry)) {
        const available = usageAvailablePercent(entry);
        return available == null
            ? { sortGroup: 1, sortValue: 0 }
            : { sortGroup: 0, sortValue: -available };
    }

    const delay = usageResetDelayMs(entry);
    return delay == null
        ? { sortGroup: 3, sortValue: Number.POSITIVE_INFINITY }
        : { sortGroup: 2, sortValue: delay };
}

function compareUsageMenuItems(
    a: { name: string; entry: ProfileUsageEntry | null },
    b: { name: string; entry: ProfileUsageEntry | null },
): number {
    const aSort = usageSort(a.entry);
    const bSort = usageSort(b.entry);
    return aSort.sortGroup - bSort.sortGroup
        || aSort.sortValue - bSort.sortValue
        || a.name.localeCompare(b.name);
}

function usageMenuOption(command: string, profileName: string, entry: ProfileUsageEntry | null, isDefault = false): string {
    const unavailablePrefix = usageProfileUnavailable(entry) ? usageUnavailablePrefix(entry) : null;
    const statusMarker = usageProfileMarker(entry, isDefault);
    const markerPrefix = unavailablePrefix ?? statusMarker;
    const parts = [`${markerPrefix} ${command} ${profileName}`.trim()];
    if (entry?.authExpired) parts.push('过期');
    parts.push(...formatCompactProfileUsage(entry));
    return parts.filter(Boolean).join('｜');
}

/** Handle !usage for codex flavor. */
async function handleCodexUsage(profileArg: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    // In console mode, `@u-codex` without a profile is an account picker.
    // In a normal Codex session, bare `@u` reports the current account directly.
    if (!profileArg && ctx.isConsoleSession) {
        const codexProfiles = readCodexProfiles();

        if (codexProfiles.length === 0) {
            return { message: '❌ 未找到已登录的 Codex 账户。', action: 'none' };
        }

        const defaultProfile = getCurrentCodexProfile();
        const command = ctx.isConsoleSession ? '@u-codex' : '@u';
        const suggestions = codexProfiles
            .map(p => ({ name: p.name, entry: getCachedProfileUsageEntry(p.name, 'codex') }))
            .sort(compareUsageMenuItems)
            .map(item => usageMenuOption(command, item.name, item.entry, item.name === defaultProfile));
        return { message: [], action: 'none', suggestions };
    }

    const resolved = resolveCodexToken(profileArg || undefined);
    if (!resolved) {
        return {
            message: profileArg
                ? `❌ 未找到 Codex 账户 "${profileArg}" 的凭证。`
                : '❌ 未找到 Codex 凭证。请先 !login 登录。',
            action: 'none',
        };
    }

    ctx.client.sendSessionEvent({ type: 'message', message: '⏳ 正在查询 Codex 用量...' });

    const { token, profileLabel, cacheKey } = resolved;
    ensureHydrated();
    const cached = codexCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
        return { message: formatCodexUsage(cached.data, profileLabel, cached.fetchedAt), action: 'none' };
    }

    try {
        const data = await fetchCodexUsage(token, profileLabel);
        const now = Date.now();
        setCodexCache(cacheKey, { data, fetchedAt: now });
        return { message: formatCodexUsage(data, profileLabel, now), action: 'none' };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        logger.debug(`[!usage:codex] Failed: ${errorMsg}`);

        if (cached) {
            const messages = [...formatCodexUsage(cached.data, profileLabel, cached.fetchedAt), '⚠️ 无法获取最新数据'];
            for (const msg of messages) {
                ctx.client.sendSessionEvent({ type: 'message', message: msg });
            }
            ctx.client.sendCodexMessage({ type: 'message', message: codeBlock(errorMsg) });
            return { message: [], action: 'none' };
        }

        ctx.client.sendSessionEvent({ type: 'message', message: '❌ 获取 Codex 用量失败' });
        ctx.client.sendCodexMessage({ type: 'message', message: codeBlock(errorMsg) });
        return { message: [], action: 'none' };
    }
}

/**
 * Handle the `!usage` bang command.
 *
 * - `!usage` — Normal session: show current account usage; Console: list profiles
 * - `!usage <profile>` — Show usage for a specific CCS profile
 */
export async function handleUsageBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const codexReject = rejectCodexFlagInSession(args, ctx);
    if (codexReject) return codexReject;

    const { cleanArgs: profileArg, hasCodexFlag } = parseCodexFlag(args);

    // Codex flavor (from session) or explicit --codex flag: delegate to codex handler
    if (ctx.flavor === 'codex' || hasCodexFlag) {
        return handleCodexUsage(profileArg, ctx);
    }

    // Console session without args: list Claude profiles only
    if (ctx.isConsoleSession && !profileArg) {
        const { profiles, defaultProfile } = readCcsProfiles();
        const claudeProfiles = profiles.filter(p => readOAuthToken(p.instancePath) !== null);

        if (claudeProfiles.length === 0) {
            return { message: '❌ 未找到已登录的 Claude 账户。', action: 'none' };
        }

        const suggestions = claudeProfiles
            .map(p => ({ name: p.name, entry: getCachedProfileUsageEntry(p.name, 'claude') }))
            .sort(compareUsageMenuItems)
            .map(item => usageMenuOption('@u', item.name, item.entry, item.name === defaultProfile));
        return { message: [], action: 'none', suggestions };
    }

    // Resolve token: by profile name arg, or current session
    let resolved: { token: string; profileLabel: string; cacheKey: string } | null;
    if (profileArg) {
        resolved = resolveOAuthTokenForProfile(profileArg);
        if (!resolved) {
            return { message: `❌ 未找到账户 "${profileArg}" 的 OAuth 凭证。`, action: 'none' };
        }
    } else {
        resolved = resolveOAuthToken();
    }

    if (!resolved) {
        return {
            message: '❌ 未找到 OAuth 凭证。请确认已通过 CCS 或 Claude CLI 登录。',
            action: 'none',
        };
    }

    // Send loading indicator (after profile list check, so listing doesn't show loading)
    ctx.client.sendSessionEvent({ type: 'message', message: '⏳ 正在查询用量...' });

    const { token, profileLabel, cacheKey } = resolved;

    // Check cache
    ensureHydrated();
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
        logger.debug(`[!usage] Returning cached usage for profile: ${profileLabel}`);
        return {
            message: formatUsage(cached.data, profileLabel, cached.fetchedAt),
            action: 'none',
        };
    }

    // Fetch fresh data (retry once with re-read token on auth failures)
    try {
        logger.debug(`[!usage] Fetching usage for profile: ${profileLabel}, configDir=${process.env.CLAUDE_CONFIG_DIR ?? '(unset)'}`);
        const data = await fetchUsage(token, profileLabel);
        const now = Date.now();

        setClaudeCache(cacheKey, { data, fetchedAt: now });

        return {
            message: formatUsage(data, profileLabel, now),
            action: 'none',
        };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        logger.debug(`[!usage] Failed to fetch usage: ${errorMsg}`);

        // On auth errors (401/403), re-read token from disk and retry once
        // The daemon may hold a stale token while the credential file has been refreshed
        const isAuthError = errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('过期') || errorMsg.includes('被拒绝');
        if (isAuthError) {
            logger.debug(`[!usage] Auth error detected, re-reading token from disk...`);
            const refreshed = resolveOAuthToken();
            if (refreshed && refreshed.token !== token) {
                logger.debug(`[!usage] Token changed on disk, retrying with fresh token`);
                try {
                    const data = await fetchUsage(refreshed.token, refreshed.profileLabel);
                    const now = Date.now();
                    setClaudeCache(refreshed.cacheKey, { data, fetchedAt: now });
                    return {
                        message: formatUsage(data, refreshed.profileLabel, now),
                        action: 'none',
                    };
                } catch (retryError) {
                    const retryMsg = retryError instanceof Error ? retryError.message : 'Unknown error';
                    logger.debug(`[!usage] Retry also failed: ${retryMsg}`);
                }
            }
        }

        // Return stale cache if available, with error detail as codex message
        if (cached) {
            const messages = [...formatUsage(cached.data, profileLabel, cached.fetchedAt), '⚠️ 无法获取最新数据'];
            for (const msg of messages) {
                ctx.client.sendSessionEvent({ type: 'message', message: msg });
            }
            ctx.client.sendCodexMessage({ type: 'message', message: codeBlock(errorMsg) });
            return { message: [], action: 'none' };
        }

        ctx.client.sendSessionEvent({ type: 'message', message: '❌ 获取用量失败' });
        ctx.client.sendCodexMessage({ type: 'message', message: codeBlock(errorMsg) });
        return { message: [], action: 'none' };
    }
}

// ============================================================================
// Programmatic rate-limit usage query (used by claudeRemoteLauncher on 429)
// ============================================================================

/** Which usage windows are over limit + switchable profiles. */
export interface RateLimitContext {
    /** Current profile name */
    currentProfile: string
    /** Windows that are at or over 80% utilization, sorted by utilization descending */
    overLimitWindows: Array<{ label: string; utilization: number; resetsIn: string }>
    /** Other shared CCS profiles with available quota */
    switchableProfiles: string[]
    /** True when all known shared profiles with credentials are over limit */
    allProfilesOverLimit: boolean
}

/**
 * Fetch usage for the current profile and find which windows triggered the rate limit.
 * Also scans other shared CCS profiles for ones with available quota.
 * Returns null if usage data cannot be fetched (no token, API error, etc.).
 *
 * Only profiles in `shared` mode are considered switchable, matching the
 * constraint enforced by `!auth` (authCommand.ts switchProfile).
 *
 * This is a fire-and-forget helper — callers should not block on it.
 */
export async function queryRateLimitContext(): Promise<RateLimitContext | null> {
    const resolved = resolveOAuthToken();
    if (!resolved) return null;

    const { token, profileLabel, cacheKey } = resolved;

    // Fetch current profile usage (use cache if fresh)
    ensureHydrated();
    let data: UsageData;
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
        data = cached.data;
    } else {
        try {
            data = await fetchUsage(token, profileLabel);
            setClaudeCache(cacheKey, { data, fetchedAt: Date.now() });
        } catch (e) {
            logger.debug(`[rateLimitContext] Failed to fetch usage for ${profileLabel}: ${e}`);
            return null;
        }
    }

    // Find windows over 80% utilization
    const THRESHOLD = 80;
    const windows: Array<{ label: string; utilization: number; resetsIn: string }> = [];
    if (data.five_hour && data.five_hour.utilization >= THRESHOLD) {
        windows.push({ label: '5 小时窗口', utilization: data.five_hour.utilization, resetsIn: formatResetTime(data.five_hour.resets_at) });
    }
    if (data.seven_day && data.seven_day.utilization >= THRESHOLD) {
        windows.push({ label: '7 天总量', utilization: data.seven_day.utilization, resetsIn: formatResetTime(data.seven_day.resets_at) });
    }
    if (data.seven_day_opus && data.seven_day_opus.utilization >= THRESHOLD) {
        windows.push({ label: 'Opus 7天', utilization: data.seven_day_opus.utilization, resetsIn: formatResetTime(data.seven_day_opus.resets_at) });
    }
    if (data.seven_day_sonnet && data.seven_day_sonnet.utilization >= THRESHOLD) {
        windows.push({ label: 'Sonnet 7天', utilization: data.seven_day_sonnet.utilization, resetsIn: formatResetTime(data.seven_day_sonnet.resets_at) });
    }
    windows.sort((a, b) => b.utilization - a.utilization);

    // Find switchable profiles with credentials
    const currentFiveHour = data.five_hour?.utilization ?? 0;
    const { profiles } = readCcsProfiles();

    const switchable: string[] = [];
    let checkedCount = 0;
    let overLimitCount = 0;

    for (const p of profiles) {
        if (p.name === profileLabel) continue;

        const otherToken = readOAuthToken(p.instancePath);
        if (!otherToken) continue;

        checkedCount++;

        // Check cached usage for the other profile
        const otherCached = cache.get(p.instancePath);
        if (otherCached && (Date.now() - otherCached.fetchedAt) < CACHE_TTL_MS) {
            const other5h = otherCached.data.five_hour?.utilization ?? 0;
            if (other5h < currentFiveHour && other5h < THRESHOLD) {
                switchable.push(p.name);
            } else if (other5h >= THRESHOLD) {
                overLimitCount++;
            }
            continue;
        }

        // Try fetching usage for the other profile (best-effort)
        try {
            const otherData = await fetchUsage(otherToken, p.name);
            setClaudeCache(p.instancePath, { data: otherData, fetchedAt: Date.now() });
            const other5h = otherData.five_hour?.utilization ?? 0;
            if (other5h < currentFiveHour && other5h < THRESHOLD) {
                switchable.push(p.name);
            } else if (other5h >= THRESHOLD) {
                overLimitCount++;
            }
        } catch (e) {
            logger.debug(`[rateLimitContext] Failed to fetch usage for ${p.name}: ${e}`);
            // Don't add — can't verify this profile has available quota
        }
    }

    // All profiles over limit: current must be over threshold + no switchable found
    // + either no peers exist (single profile) or every checked peer is also over
    const currentOverLimit = (data.five_hour?.utilization ?? 0) >= THRESHOLD;
    const allProfilesOverLimit = currentOverLimit && switchable.length === 0 && (checkedCount === 0 || overLimitCount === checkedCount);

    return { currentProfile: profileLabel, overLimitWindows: windows, switchableProfiles: switchable, allProfilesOverLimit };
}
