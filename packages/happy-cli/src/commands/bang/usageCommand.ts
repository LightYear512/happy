import { readFileSync, writeFileSync } from 'node:fs';
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
const CACHE_TTL_MS = 15 * 60 * 1000;
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

const cache = new Map<string, CachedUsage>();

export function resolveOAuthToken(): { token: string; profileLabel: string; cacheKey: string } | null {
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    logger.debug(`[!usage] resolveOAuthToken: CLAUDE_CONFIG_DIR=${configDir ?? '(unset)'}`);
    if (configDir) {
        const token = readOAuthToken(configDir);
        logger.debug(`[!usage] CCS configDir=${configDir}, token found=${!!token}`);
        if (token) {
            const profileName = getCurrentCcsProfile() ?? configDir;
            return { token, profileLabel: profileName, cacheKey: configDir };
        }
    }
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
        if (token) logger.debug(`[!usage] Keychain service=${service}, token found=true`);
    } catch {}
    keychainCache.set(configDir, { token, ts: Date.now() });
    return token;
}

export function readOAuthToken(configDir: string): string | null {
    const credPath = join(configDir, '.credentials.json');
    const token = readTokenFromFile(credPath);
    if (token) return token;
    return readTokenFromKeychain(configDir);
}

function resolveProxy(): string | null {
    const fromEnv = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    if (fromEnv) return fromEnv;
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
        } catch {}
    }
    return null;
}

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
        if (response.status === 401) throw new Error('OAuth 令牌已过期或无效。请在 cc 中发送任意消息以刷新令牌后重试，若仍失败请 !login 重新登录。');
        if (response.status === 403) throw new Error('请求被拒绝 (403)，请尝试重新登录。');
        if (response.status === 429) throw new Error('Anthropic API 限流，请稍后再试。');
        throw new Error(`API 返回 ${response.status}: ${text}`);
    }
    return await response.json() as UsageData;
}

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

function usageBar(utilization: number): string {
    const total = 15;
    const filled = Math.max(0, Math.min(total, Math.round(utilization / 100 * total)));
    const bar = '█'.repeat(filled) + '░'.repeat(total - filled);
    return `[${bar}] ${utilization.toFixed(0)}%`;
}

export function getCachedUsageSummary(cacheKey: string): string | null {
    const cached = cache.get(cacheKey);
    if (!cached || (Date.now() - cached.fetchedAt) >= CACHE_TTL_MS) return null;
    return formatClaudeUsageSummary(cached.data);
}

export interface ProfileUsageEntry {
    summary: string | null;
    authExpired: boolean;
    stale: boolean;
    cachedAt: number | null;
}

function isAuthExpiredError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.message.includes('令牌已过期') || err.message.includes('令牌已过期或无效');
}

const inflightRevalidate = new Set<string>();

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

export async function fetchProfileUsageSummary(profileName: string, flavor: AuthFlavor): Promise<ProfileUsageEntry> {
    ensureHydrated();
    const isCodex = flavor === 'codex';
    const cacheKey = isCodex ? getCodexInstancePath(profileName) : getInstancePath(profileName);
    try {
        if (isCodex) {
            const cached = codexCache.get(cacheKey);
            const age = cached ? Date.now() - cached.fetchedAt : Infinity;
            if (cached && age < CACHE_TTL_MS) return { summary: formatCodexUsageSummary(cached.data), authExpired: false, stale: false, cachedAt: cached.fetchedAt };
            if (cached && age < STALE_TTL_MS) {
                backgroundRevalidateCodex(cacheKey, profileName);
                return { summary: formatCodexUsageSummary(cached.data), authExpired: false, stale: true, cachedAt: cached.fetchedAt };
            }
            const token = readCodexAccessToken(cacheKey);
            if (!token) return { summary: null, authExpired: false, stale: false, cachedAt: null };
            const data = await Promise.race([
                fetchCodexUsage(token, profileName),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
            ]);
            setCodexCache(cacheKey, { data, fetchedAt: Date.now() });
            return { summary: formatCodexUsageSummary(data), authExpired: false, stale: false, cachedAt: Date.now() };
        }
        const cached = cache.get(cacheKey);
        const age = cached ? Date.now() - cached.fetchedAt : Infinity;
        if (cached && age < CACHE_TTL_MS) return { summary: formatClaudeUsageSummary(cached.data), authExpired: false, stale: false, cachedAt: cached.fetchedAt };
        if (cached && age < STALE_TTL_MS) {
            backgroundRevalidateClaude(cacheKey, profileName);
            return { summary: formatClaudeUsageSummary(cached.data), authExpired: false, stale: true, cachedAt: cached.fetchedAt };
        }
        const token = readOAuthToken(cacheKey);
        if (!token) return { summary: null, authExpired: false, stale: false, cachedAt: null };
        const data = await Promise.race([
            fetchUsage(token, profileName),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        setClaudeCache(cacheKey, { data, fetchedAt: Date.now() });
        return { summary: formatClaudeUsageSummary(data), authExpired: false, stale: false, cachedAt: Date.now() };
    } catch (err) {
        logger.debug(`[!usage] fetchProfileUsageSummary failed for ${profileName}:`, err);
        const authExpired = isAuthExpiredError(err);
        const cached = isCodex ? codexCache.get(cacheKey) : cache.get(cacheKey);
        if (cached && (Date.now() - cached.fetchedAt) < STALE_TTL_MS) {
            const summary = isCodex
                ? formatCodexUsageSummary((cached as CachedCodexUsage).data)
                : formatClaudeUsageSummary((cached as CachedUsage).data);
            return { summary, authExpired, stale: true, cachedAt: cached.fetchedAt };
        }
        return { summary: null, authExpired, stale: false, cachedAt: null };
    }
}

function formatClaudeUsageSummary(data: UsageData): string | null {
    const parts: string[] = [];
    if (data.five_hour) parts.push(`5h: ${data.five_hour.utilization.toFixed(0)}%`);
    if (data.seven_day) parts.push(`7d: ${data.seven_day.utilization.toFixed(0)}%`);
    return parts.length > 0 ? `📊 ${parts.join(' · ')}` : null;
}

function formatCodexUsageSummary(data: CodexUsageData): string | null {
    const parts: string[] = [];
    if (data.primaryWindow) parts.push(`5h: ${data.primaryWindow.usedPercent.toFixed(0)}%`);
    if (data.secondaryWindow) parts.push(`7d: ${data.secondaryWindow.usedPercent.toFixed(0)}%`);
    return parts.length > 0 ? `📊 ${parts.join(' · ')}` : null;
}

export function formatUsage(data: UsageData, profileLabel: string, cachedAt: number): string[] {
    const messages: string[] = [`📊 用量 — ${profileLabel}`];
    if (data.five_hour) {
        messages.push(['⏱ 5 小时窗口', usageBar(data.five_hour.utilization), `${formatResetTime(data.five_hour.resets_at)} 后重置`].join('\n'));
    }
    if (data.seven_day) {
        messages.push(['📅 7 天总量', usageBar(data.seven_day.utilization), `${formatResetTime(data.seven_day.resets_at)} 后重置`].join('\n'));
    }
    const modelBreakdowns: Array<{ label: string; entry: { utilization: number; resets_at: string } | null }> = [
        { label: '🔮 Opus 7天', entry: data.seven_day_opus },
        { label: '✨ Sonnet 7天', entry: data.seven_day_sonnet },
    ];
    for (const { label, entry } of modelBreakdowns) {
        if (entry) messages.push(`${label}\n${usageBar(entry.utilization)}`);
    }
    if (data.extra_usage?.is_enabled) {
        const parts = ['💰 额外用量'];
        if (data.extra_usage.utilization !== null) parts.push(usageBar(data.extra_usage.utilization));
        if (data.extra_usage.used_credits !== null && data.extra_usage.monthly_limit !== null) {
            parts.push(`$${data.extra_usage.used_credits.toFixed(2)} / $${data.extra_usage.monthly_limit.toFixed(2)}`);
        }
        messages.push(parts.join('\n'));
    }
    const ageMs = Date.now() - cachedAt;
    if (ageMs >= 6000) {
        const remainMin = Math.ceil((CACHE_TTL_MS - ageMs) / 60000);
        messages.push(`ℹ️ 缓存于 ${formatRelativeTime(cachedAt)}（${remainMin} 分钟后刷新）`);
    }
    return messages;
}

function resolveOAuthTokenForProfile(profileName: string): { token: string; profileLabel: string; cacheKey: string } | null {
    const instancePath = getInstancePath(profileName);
    const token = readOAuthToken(instancePath);
    if (token) return { token, profileLabel: profileName, cacheKey: instancePath };
    return null;
}

// ---------------------------------------------------------------------------
// Codex usage (OpenAI wham/usage API)
// ---------------------------------------------------------------------------

const CODEX_USAGE_API_URL = 'https://chatgpt.com/backend-api/wham/usage';

interface CodexUsageData {
    planType?: string;
    primaryWindow?: { usedPercent: number; resetAt: number };
    secondaryWindow?: { usedPercent: number; resetAt: number };
    codeReviewWindow?: { usedPercent: number; resetAt: number };
}

interface CachedCodexUsage {
    data: CodexUsageData;
    fetchedAt: number;
}

const codexCache = new Map<string, CachedCodexUsage>();

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

const USAGE_CACHE_FILE = join(configuration.happyHomeDir, 'usage-cache.json');
const USAGE_CACHE_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 500;

let hydrated = false;
let persistTimer: NodeJS.Timeout | null = null;

function ensureHydrated(): void {
    if (hydrated) return;
    hydrated = true;
    let raw: string;
    try {
        raw = readFileSync(USAGE_CACHE_FILE, 'utf-8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') logger.debug('[!usage] failed to read usage-cache:', err);
        return;
    }
    try {
        const parsed = JSON.parse(raw) as {
            version?: number;
            claude?: Record<string, CachedUsage>;
            codex?: Record<string, CachedCodexUsage>;
        };
        if (parsed.version !== USAGE_CACHE_VERSION) {
            logger.debug(`[!usage] usage-cache version mismatch (${parsed.version} vs ${USAGE_CACHE_VERSION}), ignoring`);
            return;
        }
        const now = Date.now();
        for (const [key, entry] of Object.entries(parsed.claude ?? {})) {
            if (!entry || typeof entry.fetchedAt !== 'number') continue;
            if ((now - entry.fetchedAt) >= STALE_TTL_MS) continue;
            cache.set(key, entry);
        }
        for (const [key, entry] of Object.entries(parsed.codex ?? {})) {
            if (!entry || typeof entry.fetchedAt !== 'number') continue;
            if ((now - entry.fetchedAt) >= STALE_TTL_MS) continue;
            codexCache.set(key, entry);
        }
        logger.debug(`[!usage] hydrated usage-cache: claude=${cache.size} codex=${codexCache.size}`);
    } catch (err) {
        logger.debug('[!usage] failed to hydrate usage-cache:', err);
    }
}

function schedulePersist(): void {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        try {
            const payload = {
                version: USAGE_CACHE_VERSION,
                claude: Object.fromEntries(cache.entries()),
                codex: Object.fromEntries(codexCache.entries()),
            };
            writeFileSync(USAGE_CACHE_FILE, JSON.stringify(payload), 'utf-8');
        } catch (err) {
            logger.debug('[!usage] failed to persist usage-cache:', err);
        }
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
}

function setClaudeCache(key: string, entry: CachedUsage): void {
    cache.set(key, entry);
    schedulePersist();
}

function setCodexCache(key: string, entry: CachedCodexUsage): void {
    codexCache.set(key, entry);
    schedulePersist();
}

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

function resolveCodexToken(profileName?: string): { token: string; profileLabel: string; cacheKey: string } | null {
    if (profileName) {
        const codexHome = getCodexInstancePath(profileName);
        const token = readCodexAccessToken(codexHome);
        if (token) return { token, profileLabel: profileName, cacheKey: codexHome };
        return null;
    }
    const codexHome = process.env.CODEX_HOME;
    if (!codexHome) return null;
    const token = readCodexAccessToken(codexHome);
    if (token) {
        const label = getCurrentCodexProfile() ?? 'default';
        return { token, profileLabel: label, cacheKey: codexHome };
    }
    return null;
}

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
    if (proxy) (fetchOptions as Record<string, unknown>).dispatcher = new ProxyAgent(proxy);
    const response = await undiciFetch(CODEX_USAGE_API_URL, fetchOptions);
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        logger.debug(`[!usage:codex] API error: ${response.status} ${text}`);
        if (response.status === 401) throw new Error('Codex OAuth 令牌已过期。请 !login 重新登录。');
        if (response.status === 403) throw new Error('无 Codex 访问权限或请求被拒绝 (403)。');
        throw new Error(`API 返回 ${response.status}: ${text}`);
    }
    const raw = await response.json() as Record<string, unknown>;
    const result: CodexUsageData = { planType: raw.plan_type as string | undefined };
    const rateLimit = raw.rate_limit as Record<string, { used_percent?: number; reset_at?: number }> | undefined;
    if (rateLimit?.primary_window) {
        result.primaryWindow = { usedPercent: rateLimit.primary_window.used_percent ?? 0, resetAt: rateLimit.primary_window.reset_at ?? 0 };
    }
    if (rateLimit?.secondary_window) {
        result.secondaryWindow = { usedPercent: rateLimit.secondary_window.used_percent ?? 0, resetAt: rateLimit.secondary_window.reset_at ?? 0 };
    }
    const codeReview = raw.code_review_rate_limit as { used_percent?: number; reset_at?: number } | null;
    if (codeReview) {
        result.codeReviewWindow = { usedPercent: codeReview.used_percent ?? 0, resetAt: codeReview.reset_at ?? 0 };
    }
    return result;
}

function unixToIso(ts: number): string {
    return new Date(ts * 1000).toISOString();
}

function formatCodexUsage(data: CodexUsageData, profileLabel: string, cachedAt: number): string[] {
    const planLabel = data.planType ? ` (${data.planType})` : '';
    const messages: string[] = [`📊 Codex 用量 — ${profileLabel}${planLabel}`];
    if (data.primaryWindow) {
        messages.push(['⏱ 5 小时窗口', usageBar(data.primaryWindow.usedPercent),
            data.primaryWindow.resetAt ? `${formatResetTime(unixToIso(data.primaryWindow.resetAt))} 后重置` : ''].filter(Boolean).join('\n'));
    }
    if (data.secondaryWindow) {
        messages.push(['📅 周限额', usageBar(data.secondaryWindow.usedPercent),
            data.secondaryWindow.resetAt ? `${formatResetTime(unixToIso(data.secondaryWindow.resetAt))} 后重置` : ''].filter(Boolean).join('\n'));
    }
    if (data.codeReviewWindow) {
        messages.push(['🔍 Code Review', usageBar(data.codeReviewWindow.usedPercent),
            data.codeReviewWindow.resetAt ? `${formatResetTime(unixToIso(data.codeReviewWindow.resetAt))} 后重置` : ''].filter(Boolean).join('\n'));
    }
    if (!data.primaryWindow && !data.secondaryWindow && !data.codeReviewWindow) messages.push('暂无用量数据');
    const ageMs = Date.now() - cachedAt;
    const ageSec = Math.floor(ageMs / 1000);
    if (ageSec > 5) {
        const ageMin = Math.floor(ageSec / 60);
        const ageStr = ageMin > 0 ? `${ageMin} 分钟前` : `${ageSec} 秒前`;
        const remainMin = Math.ceil((CACHE_TTL_MS - ageMs) / 60000);
        messages.push(`ℹ️ 缓存于 ${ageStr}（${remainMin} 分钟后刷新）`);
    }
    return messages;
}

async function handleCodexUsage(profileArg: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    if (ctx.isConsoleSession && !profileArg) {
        const codexProfiles = readCodexProfiles();
        if (codexProfiles.length === 0) return { message: '❌ 未找到已登录的 Codex 账户。', action: 'none' };
        const messages: string[] = ['📊 请选择要查询的 Codex 账户:', SEPARATOR];
        for (const p of codexProfiles) messages.push(p.name);
        messages.push(SEPARATOR, '用法: !usage --codex <账户名>');
        const suggestions = codexProfiles.map(p => `!usage --codex ${p.name}`);
        return { message: messages, action: 'none', suggestions };
    }
    const resolved = resolveCodexToken(profileArg || undefined);
    if (!resolved) {
        return {
            message: profileArg ? `❌ 未找到 Codex 账户 "${profileArg}" 的凭证。` : '❌ 未找到 Codex 凭证。请先 !login 登录。',
            action: 'none',
        };
    }
    ctx.client.sendSessionEvent({ type: 'message', message: '⏳ 正在查询 Codex 用量...' });
    const { token, profileLabel, cacheKey } = resolved;
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
            for (const msg of messages) ctx.client.sendSessionEvent({ type: 'message', message: msg });
            ctx.client.sendCodexMessage({ type: 'message', message: codeBlock(errorMsg) });
            return { message: [], action: 'none' };
        }
        ctx.client.sendSessionEvent({ type: 'message', message: '❌ 获取 Codex 用量失败' });
        ctx.client.sendCodexMessage({ type: 'message', message: codeBlock(errorMsg) });
        return { message: [], action: 'none' };
    }
}

export async function handleUsageBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const codexReject = rejectCodexFlagInSession(args, ctx);
    if (codexReject) return codexReject;
    const { cleanArgs: profileArg, hasCodexFlag } = parseCodexFlag(args);
    if (ctx.flavor === 'codex' || hasCodexFlag) return handleCodexUsage(profileArg, ctx);
    if (ctx.isConsoleSession && !profileArg) {
        const { profiles, defaultProfile } = readCcsProfiles();
        const claudeProfiles = profiles.filter(p => readOAuthToken(p.instancePath) !== null);
        if (claudeProfiles.length === 0) return { message: '❌ 未找到已登录的 Claude 账户。', action: 'none' };
        const messages: string[] = ['📊 请选择要查询的 Claude 账户:', SEPARATOR];
        for (const p of claudeProfiles) {
            const marker = p.name === defaultProfile ? ' (默认)' : '';
            messages.push(`${p.name}${marker}`);
        }
        messages.push(SEPARATOR, '用法: !usage <账户名>');
        const suggestions = claudeProfiles.map(p => `!usage ${p.name}`);
        return { message: messages, action: 'none', suggestions };
    }
    let resolved: { token: string; profileLabel: string; cacheKey: string } | null;
    if (profileArg) {
        resolved = resolveOAuthTokenForProfile(profileArg);
        if (!resolved) return { message: `❌ 未找到账户 "${profileArg}" 的 OAuth 凭证。`, action: 'none' };
    } else {
        resolved = resolveOAuthToken();
    }
    if (!resolved) return { message: '❌ 未找到 OAuth 凭证。请确认已通过 CCS 或 Claude CLI 登录。', action: 'none' };
    ctx.client.sendSessionEvent({ type: 'message', message: '⏳ 正在查询用量...' });
    const { token, profileLabel, cacheKey } = resolved;
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
        logger.debug(`[!usage] Returning cached usage for profile: ${profileLabel}`);
        return { message: formatUsage(cached.data, profileLabel, cached.fetchedAt), action: 'none' };
    }
    try {
        logger.debug(`[!usage] Fetching usage for profile: ${profileLabel}, configDir=${process.env.CLAUDE_CONFIG_DIR ?? '(unset)'}`);
        const data = await fetchUsage(token, profileLabel);
        const now = Date.now();
        setClaudeCache(cacheKey, { data, fetchedAt: now });
        return { message: formatUsage(data, profileLabel, now), action: 'none' };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        logger.debug(`[!usage] Failed to fetch usage: ${errorMsg}`);
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
                    return { message: formatUsage(data, refreshed.profileLabel, now), action: 'none' };
                } catch (retryError) {
                    const retryMsg = retryError instanceof Error ? retryError.message : 'Unknown error';
                    logger.debug(`[!usage] Retry also failed: ${retryMsg}`);
                }
            }
        }
        if (cached) {
            const messages = [...formatUsage(cached.data, profileLabel, cached.fetchedAt), '⚠️ 无法获取最新数据'];
            for (const msg of messages) ctx.client.sendSessionEvent({ type: 'message', message: msg });
            ctx.client.sendCodexMessage({ type: 'message', message: codeBlock(errorMsg) });
            return { message: [], action: 'none' };
        }
        ctx.client.sendSessionEvent({ type: 'message', message: '❌ 获取用量失败' });
        ctx.client.sendCodexMessage({ type: 'message', message: codeBlock(errorMsg) });
        return { message: [], action: 'none' };
    }
}

// ============================================================================
// Programmatic rate-limit usage query
// ============================================================================

export interface RateLimitContext {
    currentProfile: string
    overLimitWindows: Array<{ label: string; utilization: number; resetsIn: string }>
    switchableProfiles: string[]
    allProfilesOverLimit: boolean
}

export async function queryRateLimitContext(): Promise<RateLimitContext | null> {
    const resolved = resolveOAuthToken();
    if (!resolved) return null;
    const { token, profileLabel, cacheKey } = resolved;
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
    const THRESHOLD = 80;
    const windows: Array<{ label: string; utilization: number; resetsIn: string }> = [];
    if (data.five_hour && data.five_hour.utilization >= THRESHOLD) windows.push({ label: '5 小时窗口', utilization: data.five_hour.utilization, resetsIn: formatResetTime(data.five_hour.resets_at) });
    if (data.seven_day && data.seven_day.utilization >= THRESHOLD) windows.push({ label: '7 天总量', utilization: data.seven_day.utilization, resetsIn: formatResetTime(data.seven_day.resets_at) });
    if (data.seven_day_opus && data.seven_day_opus.utilization >= THRESHOLD) windows.push({ label: 'Opus 7天', utilization: data.seven_day_opus.utilization, resetsIn: formatResetTime(data.seven_day_opus.resets_at) });
    if (data.seven_day_sonnet && data.seven_day_sonnet.utilization >= THRESHOLD) windows.push({ label: 'Sonnet 7天', utilization: data.seven_day_sonnet.utilization, resetsIn: formatResetTime(data.seven_day_sonnet.resets_at) });
    windows.sort((a, b) => b.utilization - a.utilization);
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
        }
    }
    const currentOverLimit = (data.five_hour?.utilization ?? 0) >= THRESHOLD;
    const allProfilesOverLimit = currentOverLimit && switchable.length === 0 && (checkedCount === 0 || overLimitCount === checkedCount);
    return { currentProfile: profileLabel, overLimitWindows: windows, switchableProfiles: switchable, allProfilesOverLimit };
}
