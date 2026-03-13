import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';
import { getCurrentCcsProfile } from './ccsProfiles';
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

    // Try CCS profile credentials first
    if (configDir) {
        const credPath = join(configDir, '.credentials.json');
        const token = readTokenFromFile(credPath);
        if (token) {
            const profileName = getCurrentCcsProfile() ?? configDir;
            return { token, profileLabel: profileName, cacheKey: configDir };
        }
    }

    // Fallback to default ~/.claude/.credentials.json
    const defaultCredPath = join(homedir(), '.claude', '.credentials.json');
    const token = readTokenFromFile(defaultCredPath);
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
 * Fetch usage data from the Anthropic OAuth usage API.
 */
async function fetchUsage(token: string): Promise<UsageData> {
    const response = await fetch(USAGE_API_URL, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
        },
    });

    if (!response.ok) {
        if (response.status === 401) {
            throw new Error('OAuth token expired or invalid. Please re-authenticate your CCS profile.');
        }
        if (response.status === 429) {
            throw new Error('Rate limited by Anthropic API. Try again later.');
        }
        const text = await response.text().catch(() => '');
        throw new Error(`API returned ${response.status}: ${text}`);
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

    if (diffMs <= 0) return 'now';

    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${diffMin}m`;

    const diffHours = Math.floor(diffMin / 60);
    const remainMin = diffMin % 60;
    if (diffHours < 24) return remainMin > 0 ? `${diffHours}h ${remainMin}m` : `${diffHours}h`;

    const diffDays = Math.floor(diffHours / 24);
    const remainHours = diffHours % 24;
    return remainHours > 0 ? `${diffDays}d ${remainHours}h` : `${diffDays}d`;
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
 * Format the usage data into a readable message.
 */
function formatUsage(data: UsageData, profileLabel: string, cachedAt: number): string {
    const lines: string[] = [];

    lines.push(`📊 Usage — ${profileLabel}`);
    lines.push('');

    // 5-hour window
    if (data.five_hour) {
        lines.push(`⏱ 5-Hour Window`);
        lines.push(`  ${usageBar(data.five_hour.utilization)}`);
        lines.push(`  Resets in ${formatResetTime(data.five_hour.resets_at)}`);
        lines.push('');
    }

    // 7-day overall
    if (data.seven_day) {
        lines.push(`📅 7-Day Overall`);
        lines.push(`  ${usageBar(data.seven_day.utilization)}`);
        lines.push(`  Resets in ${formatResetTime(data.seven_day.resets_at)}`);
        lines.push('');
    }

    // 7-day per-model breakdowns (only show if present)
    const modelBreakdowns: Array<{ label: string; entry: { utilization: number; resets_at: string } | null }> = [
        { label: 'Opus', entry: data.seven_day_opus },
        { label: 'Sonnet', entry: data.seven_day_sonnet },
    ];

    for (const { label, entry } of modelBreakdowns) {
        if (entry) {
            lines.push(`  ${label}: ${usageBar(entry.utilization)}`);
        }
    }

    if (modelBreakdowns.some(m => m.entry)) {
        lines.push('');
    }

    // Extra usage
    if (data.extra_usage?.is_enabled) {
        lines.push(`💰 Extra Usage`);
        if (data.extra_usage.utilization !== null) {
            lines.push(`  ${usageBar(data.extra_usage.utilization)}`);
        }
        if (data.extra_usage.used_credits !== null && data.extra_usage.monthly_limit !== null) {
            lines.push(`  $${data.extra_usage.used_credits.toFixed(2)} / $${data.extra_usage.monthly_limit.toFixed(2)}`);
        }
        lines.push('');
    }

    // Cache info
    const ageMs = Date.now() - cachedAt;
    const ageSec = Math.floor(ageMs / 1000);
    if (ageSec > 5) {
        const ageMin = Math.floor(ageSec / 60);
        lines.push(`ℹ️ Cached ${ageMin > 0 ? `${ageMin}m ago` : `${ageSec}s ago`} (15min TTL)`);
    }

    return lines.join('\n');
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
            message: '❌ No OAuth credentials found. Make sure you are logged in via CCS or Claude CLI.',
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

    // Fetch fresh data
    try {
        logger.debug(`[!usage] Fetching usage for profile: ${profileLabel}`);
        const data = await fetchUsage(token);
        const now = Date.now();

        cache.set(cacheKey, { data, fetchedAt: now });

        return {
            message: formatUsage(data, profileLabel, now),
            action: 'none',
        };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        logger.debug(`[!usage] Failed to fetch usage: ${errorMsg}`);

        // Return stale cache if available
        if (cached) {
            return {
                message: formatUsage(cached.data, profileLabel, cached.fetchedAt) + '\n\n⚠️ Fresh data unavailable: ' + errorMsg,
                action: 'none',
            };
        }

        return {
            message: `❌ Failed to fetch usage: ${errorMsg}`,
            action: 'none',
        };
    }
}
