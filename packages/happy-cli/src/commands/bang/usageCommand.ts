import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { request } from 'node:https';
import { logger } from '@/ui/logger';
import { getCurrentCcsProfile } from './ccsProfiles';
import { centerText } from './format';
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
 * Direct HTTPS request that bypasses HTTP_PROXY/HTTPS_PROXY env vars.
 * Node.js global fetch respects proxy env vars, which causes Cloudflare to return 403.
 */
function directGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    const parsed = new URL(url);
    return new Promise((resolve, reject) => {
        const req = request({
            hostname: parsed.hostname,
            port: 443,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.setTimeout(10_000, () => { req.destroy(new Error('Request timed out')); });
        req.end();
    });
}

/**
 * Fetch usage data from the Anthropic OAuth usage API.
 */
async function fetchUsage(token: string, debugLabel: string): Promise<UsageData> {
    const tokenPrefix = token.substring(0, 15) + '...';
    logger.debug(`[!usage] Calling ${USAGE_API_URL} with token=${tokenPrefix} label=${debugLabel}`);

    const { status, body } = await directGet(USAGE_API_URL, {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
    });

    if (status < 200 || status >= 300) {
        logger.debug(`[!usage] API error: ${status} ${body}`);
        if (status === 401) {
            throw new Error('OAuth 令牌已过期或无效，请重新认证 CCS 配置。');
        }
        if (status === 403) {
            throw new Error('请求被拒绝 (403)，请尝试重新登录。');
        }
        if (status === 429) {
            throw new Error('Anthropic API 限流，请稍后再试。');
        }
        throw new Error(`API 返回 ${status}: ${body}`);
    }

    return JSON.parse(body) as UsageData;
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
    const clamped = Math.max(0, Math.min(20, Math.round(utilization / 5)));
    const bar = '█'.repeat(clamped) + '░'.repeat(20 - clamped);
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
function formatUsage(data: UsageData, profileLabel: string, cachedAt: number): string {
    const lines: string[] = [];

    lines.push(`📊 用量 — ${profileLabel}`);
    lines.push('');

    // 5-hour window
    if (data.five_hour) {
        lines.push('⏱ 5 小时窗口');
        lines.push(`${usageBar(data.five_hour.utilization)}`);
        lines.push(`${formatResetTime(data.five_hour.resets_at)} 后重置`);
        lines.push('');
    }

    // 7-day overall
    if (data.seven_day) {
        lines.push('📅 7 天总量');
        lines.push(`${usageBar(data.seven_day.utilization)}`);
        lines.push(`${formatResetTime(data.seven_day.resets_at)} 后重置`);
        lines.push('');
    }

    // 7-day per-model breakdowns (only show if present)
    const modelBreakdowns: Array<{ label: string; entry: { utilization: number; resets_at: string } | null }> = [
        { label: 'Opus', entry: data.seven_day_opus },
        { label: 'Sonnet', entry: data.seven_day_sonnet },
    ];

    for (const { label, entry } of modelBreakdowns) {
        if (entry) {
            lines.push(`${label}: ${usageBar(entry.utilization)}`);
        }
    }

    if (modelBreakdowns.some(m => m.entry)) {
        lines.push('');
    }

    // Extra usage
    if (data.extra_usage?.is_enabled) {
        lines.push('💰 额外用量');
        if (data.extra_usage.utilization !== null) {
            lines.push(`${usageBar(data.extra_usage.utilization)}`);
        }
        if (data.extra_usage.used_credits !== null && data.extra_usage.monthly_limit !== null) {
            lines.push(`$${data.extra_usage.used_credits.toFixed(2)} / $${data.extra_usage.monthly_limit.toFixed(2)}`);
        }
        lines.push('');
    }

    // Cache info
    const ageMs = Date.now() - cachedAt;
    const ageSec = Math.floor(ageMs / 1000);
    if (ageSec > 5) {
        const ageMin = Math.floor(ageSec / 60);
        const ageStr = ageMin > 0 ? `${ageMin} 分钟前` : `${ageSec} 秒前`;
        lines.push(`ℹ️ 缓存于 ${ageStr}`);
    }

    return centerText(lines);
}

/**
 * Handle the `!usage` bang command.
 *
 * - `!usage` — Show current OAuth account usage with 15-minute cache
 */
export async function handleUsageBangCommand(_args: string, _ctx: BangCommandContext): Promise<BangCommandResult> {
    const resolved = resolveOAuthToken();
    if (!resolved) {
        return {
            message: '❌ 未找到 OAuth 凭证。请确认已通过 CCS 或 Claude CLI 登录。',
            action: 'none',
        };
    }

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
