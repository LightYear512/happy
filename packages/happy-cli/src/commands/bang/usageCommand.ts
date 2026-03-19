import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { logger } from '@/ui/logger';
import { getCurrentCcsProfile, readCcsProfiles, getInstancePath } from './ccsProfiles';
import type { BangCommandContext, BangCommandResult } from './types';

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface UsageData {
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
function resolveOAuthToken(): { token: string; profileLabel: string; cacheKey: string } | null {
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    logger.debug(`[!usage] resolveOAuthToken: CLAUDE_CONFIG_DIR=${configDir ?? '(unset)'}`);

    // Try CCS profile credentials first
    if (configDir) {
        const credPath = join(configDir, '.credentials.json');
        const token = readTokenFromFile(credPath);
        logger.debug(`[!usage] CCS cred path=${credPath}, token found=${!!token}`);
        if (token) {
            const profileName = getCurrentCcsProfile() ?? configDir;
            return { token, profileLabel: profileName, cacheKey: configDir };
        }
    }

    // Fallback to default ~/.claude/.credentials.json
    const defaultCredPath = join(homedir(), '.claude', '.credentials.json');
    const token = readTokenFromFile(defaultCredPath);
    logger.debug(`[!usage] Default cred path=${defaultCredPath}, token found=${!!token}`);
    if (token) {
        return { token, profileLabel: 'default', cacheKey: defaultCredPath };
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
async function fetchUsage(token: string, debugLabel: string): Promise<UsageData> {
    const tokenPrefix = token.substring(0, 15) + '...';
    const proxy = resolveProxy();
    logger.debug(`[!usage] Calling ${USAGE_API_URL} token=${tokenPrefix} label=${debugLabel} proxy=${proxy ?? '(none)'}`);

    const fetchOptions: Parameters<typeof undiciFetch>[1] = {
        headers: {
            'Authorization': `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(10_000),
    };

    if (proxy) {
        (fetchOptions as Record<string, unknown>).dispatcher = new ProxyAgent(proxy);
    }

    const response = await undiciFetch(USAGE_API_URL, fetchOptions);

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        logger.debug(`[!usage] API error: ${response.status} ${text}`);
        if (response.status === 401) {
            throw new Error('OAuth 令牌已过期或无效，请重新认证 CCS 配置。');
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
function formatResetTime(resetsAt: string): string {
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
    const clamped = Math.max(0, Math.min(10, Math.round(utilization / 10)));
    const bar = '█'.repeat(clamped) + '░'.repeat(10 - clamped);
    return `[${bar}] ${utilization.toFixed(0)}%`;
}

/**
 * Get a one-line usage summary from cache for a given config dir (used by !auth after switch).
 * Returns null if no cached data is available.
 */
export function getCachedUsageSummary(cacheKey: string): string | null {
    const cached = cache.get(cacheKey);
    if (!cached || (Date.now() - cached.fetchedAt) >= CACHE_TTL_MS) return null;

    const { data } = cached;
    const parts: string[] = [];

    if (data.five_hour) parts.push(`5h: ${data.five_hour.utilization.toFixed(0)}%`);
    if (data.seven_day) parts.push(`7d: ${data.seven_day.utilization.toFixed(0)}%`);

    return parts.length > 0 ? `📊 ${parts.join(' · ')}` : null;
}

/**
 * Format the usage data into a readable, centered message.
 */
function formatUsage(data: UsageData, profileLabel: string, cachedAt: number): string[] {
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

    // Cache info
    const ageMs = Date.now() - cachedAt;
    const ageSec = Math.floor(ageMs / 1000);
    if (ageSec > 5) {
        const ageMin = Math.floor(ageSec / 60);
        const ageStr = ageMin > 0 ? `${ageMin} 分钟前` : `${ageSec} 秒前`;
        messages.push(`ℹ️ 缓存于 ${ageStr}`);
    }

    return messages;
}

/**
 * Resolve OAuth token for a specific CCS profile by name.
 */
function resolveOAuthTokenForProfile(profileName: string): { token: string; profileLabel: string; cacheKey: string } | null {
    const instancePath = getInstancePath(profileName);
    const credPath = join(instancePath, '.credentials.json');
    const token = readTokenFromFile(credPath);
    if (token) {
        return { token, profileLabel: profileName, cacheKey: instancePath };
    }
    return null;
}

/**
 * Handle the `!usage` bang command.
 *
 * - `!usage` — Normal session: show current account usage; Console: list profiles
 * - `!usage <profile>` — Show usage for a specific CCS profile
 */
export async function handleUsageBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const profileArg = args.trim();

    // Console session without args: list available profiles
    if (ctx.isConsoleSession && !profileArg) {
        const { profiles, defaultProfile } = readCcsProfiles();
        // Only show profiles that have credentials
        const accountProfiles = profiles.filter(p =>
            readTokenFromFile(join(p.instancePath, '.credentials.json')) !== null
        );
        if (accountProfiles.length === 0) {
            return { message: '❌ 未找到已登录的账户。', action: 'none' };
        }
        const messages = ['📊 请选择要查询的账户:', '━━━━━━━━━━━━━━━━━━'];
        for (const p of accountProfiles) {
            const marker = p.name === defaultProfile ? ' (默认)' : '';
            messages.push(`${p.name}${marker}`);
        }
        messages.push('━━━━━━━━━━━━━━━━━━');
        messages.push('用法: !usage <账户名>');
        return { message: messages, action: 'none' };
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

        cache.set(cacheKey, { data, fetchedAt: now });

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
                    cache.set(refreshed.cacheKey, { data, fetchedAt: now });
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

        // Return stale cache if available
        if (cached) {
            return {
                message: formatUsage(cached.data, profileLabel, cached.fetchedAt) + '\n\n⚠️ 无法获取最新数据: ' + errorMsg,
                action: 'none',
            };
        }

        return {
            message: `❌ 获取用量失败: ${errorMsg}`,
            action: 'none',
        };
    }
}
