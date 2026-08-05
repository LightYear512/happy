import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BangCommandContext } from './types';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('undici', () => ({
    fetch: fetchMock,
    ProxyAgent: class ProxyAgent {
        constructor(_url: string) {}
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

const originalEnv = { ...process.env };

function restoreEnv(): void {
    process.env = { ...originalEnv };
}

function response(body: unknown): { ok: true; json: () => Promise<unknown>; text: () => Promise<string> } {
    return {
        ok: true,
        json: async () => body,
        text: async () => '',
    };
}

function claudeUsage(percent: number): Record<string, unknown> {
    return {
        five_hour: { utilization: percent, resets_at: '2030-01-01T00:00:00.000Z' },
        seven_day: { utilization: 10, resets_at: '2030-01-07T00:00:00.000Z' },
        seven_day_oauth_apps: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
        seven_day_cowork: null,
        extra_usage: null,
    };
}

function codexUsage(percent: number): Record<string, unknown> {
    return {
        plan_type: 'plus',
        rate_limit: {
            primary_window: { used_percent: percent, reset_at: 1893456000, limit_window_seconds: 18000 },
            secondary_window: { used_percent: 11, reset_at: 1893974400, limit_window_seconds: 604800 },
        },
        code_review_rate_limit: null,
    };
}

function partialCodexUsage(percent: number): Record<string, unknown> {
    return {
        plan_type: 'plus',
        rate_limit: {
            primary_window: { used_percent: percent, reset_at: 1893456000, limit_window_seconds: 18000 },
        },
        code_review_rate_limit: null,
    };
}

function sevenDayPrimaryCodexUsage(percent: number): Record<string, unknown> {
    return {
        plan_type: 'pro',
        rate_limit: {
            primary_window: { used_percent: percent, reset_at: 1893974400, limit_window_seconds: 604800 },
            secondary_window: null,
        },
        code_review_rate_limit: null,
    };
}

function cachedCodexUsage(percent: number): Record<string, unknown> {
    return {
        planType: 'plus',
        primaryWindow: { usedPercent: percent, resetAt: 1893456000 },
        secondaryWindow: { usedPercent: 11, resetAt: 1893974400 },
    };
}

function createClaudeProfile(root: string): string {
    const ccsDir = join(root, 'ccs');
    const instancePath = join(ccsDir, 'instances', 'work');
    mkdirSync(instancePath, { recursive: true });
    writeFileSync(join(ccsDir, 'profiles.json'), JSON.stringify({ default: 'work', work: { type: 'account' } }));
    writeFileSync(join(instancePath, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'claude-token' } }));
    process.env.CCS_DIR = ccsDir;
    process.env.CLAUDE_CONFIG_DIR = instancePath;
    return instancePath;
}

function createCodexProfile(happyHome: string): string {
    const codexHome = join(happyHome, 'auth', 'codex', 'instances', 'work');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'codex-token' } }));
    process.env.CODEX_HOME = codexHome;
    return codexHome;
}

function writeUsageCache(
    happyHome: string,
    entries: {
        claude?: Record<string, unknown>;
        codex?: Record<string, unknown>;
    },
): void {
    mkdirSync(happyHome, { recursive: true });
    writeFileSync(join(happyHome, 'usage-cache.json'), JSON.stringify({
        version: 1,
        claude: entries.claude ?? {},
        codex: entries.codex ?? {},
    }));
}

function createContext(flavor: 'claude' | 'codex' = 'claude'): BangCommandContext & {
    client: {
        sendSessionEvent: ReturnType<typeof vi.fn>;
        sendCodexMessage: ReturnType<typeof vi.fn>;
    };
} {
    return {
        flavor,
        client: {
            sendSessionEvent: vi.fn(),
            sendCodexMessage: vi.fn(),
        },
        session: null,
        messageQueue: {} as never,
        currentEnhancedMode: { permissionMode: 'default' as const },
    } as unknown as BangCommandContext & {
        client: {
            sendSessionEvent: ReturnType<typeof vi.fn>;
            sendCodexMessage: ReturnType<typeof vi.fn>;
        };
    };
}

describe('usage command cache policy', () => {
    let root: string;
    let happyHome: string;

    beforeEach(() => {
        vi.resetModules();
        fetchMock.mockReset();
        restoreEnv();
        root = mkdtempSync(join(tmpdir(), 'happy-usage-'));
        happyHome = join(root, 'happy');
        process.env.HAPPY_HOME_DIR = happyHome;
        delete process.env.HTTPS_PROXY;
        delete process.env.HTTP_PROXY;
        delete process.env.https_proxy;
        delete process.env.http_proxy;
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        restoreEnv();
        vi.resetModules();
    });

    it('fetches Claude usage first even when a fresh cache entry exists', async () => {
        const instancePath = createClaudeProfile(root);
        const cachedAt = Date.now() - 60_000;
        writeUsageCache(happyHome, {
            claude: {
                [instancePath]: { data: claudeUsage(99), fetchedAt: cachedAt },
            },
        });
        fetchMock.mockResolvedValueOnce(response(claudeUsage(23)));

        const { handleUsageBangCommand } = await import('./usageCommand');
        const result = await handleUsageBangCommand('', createContext());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const text = Array.isArray(result.message) ? result.message.join('\n') : result.message;
        expect(text).toContain('23%');
        expect(text).not.toContain('99%');
    });

    it('falls back to Claude cache only after the fresh fetch fails', async () => {
        const instancePath = createClaudeProfile(root);
        writeUsageCache(happyHome, {
            claude: {
                [instancePath]: { data: claudeUsage(88), fetchedAt: Date.now() - 60_000 },
            },
        });
        fetchMock.mockRejectedValueOnce(new Error('network down'));

        const { handleUsageBangCommand } = await import('./usageCommand');
        const ctx = createContext();
        const result = await handleUsageBangCommand('', ctx);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.message).toEqual([]);
        const sent = ctx.client.sendSessionEvent.mock.calls
            .map(([event]) => event.message)
            .join('\n');
        expect(sent).toContain('88%');
        expect(sent).toContain('无法获取最新数据');
    });

    it('fetches Codex usage first even when a fresh cache entry exists', async () => {
        const codexHome = createCodexProfile(happyHome);
        writeUsageCache(happyHome, {
            codex: {
                [codexHome]: { data: cachedCodexUsage(96), fetchedAt: Date.now() - 60_000 },
            },
        });
        fetchMock.mockResolvedValueOnce(response(codexUsage(19)));

        const { handleUsageBangCommand } = await import('./usageCommand');
        const result = await handleUsageBangCommand('', createContext('codex'));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const text = Array.isArray(result.message) ? result.message.join('\n') : result.message;
        expect(text).toContain('19%');
        expect(text).not.toContain('96%');
    });

    it('maps a single 604800-second primary provider window to 7d, not 5h', async () => {
        const codexHome = createCodexProfile(happyHome);
        fetchMock.mockResolvedValueOnce(response(sevenDayPrimaryCodexUsage(27)));

        const { fetchProfileUsageSummary } = await import('./usageCommand');
        const entry = await fetchProfileUsageSummary('work', 'codex');

        expect(entry.fiveHourPercent).toBeNull();
        expect(entry.sevenDayPercent).toBe(27);
        const persisted = JSON.parse(readFileSync(join(happyHome, 'usage-cache.json'), 'utf8'));
        expect(persisted.codex[codexHome].data.primaryWindow).toBeUndefined();
        expect(persisted.codex[codexHome].data.secondaryWindow.limitWindowSeconds).toBe(604800);
    });

    it('preserves a last-known Codex 7d window with its own age after a partial response', async () => {
        const codexHome = createCodexProfile(happyHome);
        const oldFetchedAt = Date.now() - 6 * 60_000;
        writeUsageCache(happyHome, {
            codex: {
                [codexHome]: { data: cachedCodexUsage(96), fetchedAt: oldFetchedAt },
            },
        });
        fetchMock.mockResolvedValueOnce(response(partialCodexUsage(19)));

        const { fetchProfileUsageSummary } = await import('./usageCommand');
        const entry = await fetchProfileUsageSummary('work', 'codex');
        const provenance = entry as unknown as {
            fiveHourCachedAt: number | null;
            sevenDayCachedAt: number | null;
        };

        expect(entry.fiveHourPercent).toBe(19);
        expect(entry.sevenDayPercent).toBe(11);
        expect(provenance.fiveHourCachedAt).toBeGreaterThan(oldFetchedAt);
        expect(provenance.sevenDayCachedAt).toBe(oldFetchedAt);
        const persisted = JSON.parse(readFileSync(join(happyHome, 'usage-cache.json'), 'utf8'));
        expect(persisted.codex[codexHome].data.secondaryWindow.usedPercent).toBe(11);
        expect(persisted.codex[codexHome].data.secondaryWindow.fetchedAt).toBe(oldFetchedAt);
    });

    it('merges a partial Codex response with the newest window already on disk', async () => {
        const codexHome = createCodexProfile(happyHome);
        const initialFetchedAt = Date.now() - 6 * 60_000;
        const concurrentFetchedAt = Date.now() - 60_000;
        writeUsageCache(happyHome, {
            codex: {
                [codexHome]: { data: cachedCodexUsage(96), fetchedAt: initialFetchedAt },
            },
        });
        fetchMock.mockImplementationOnce(async () => {
            writeUsageCache(happyHome, {
                codex: {
                    [codexHome]: { data: cachedCodexUsage(42), fetchedAt: concurrentFetchedAt },
                },
            });
            return response(partialCodexUsage(19));
        });

        const { fetchProfileUsageSummary } = await import('./usageCommand');
        const entry = await fetchProfileUsageSummary('work', 'codex');
        const provenance = entry as unknown as { sevenDayCachedAt: number | null };

        expect(entry.fiveHourPercent).toBe(19);
        expect(entry.sevenDayPercent).toBe(11);
        expect(provenance.sevenDayCachedAt).toBe(concurrentFetchedAt);
    });
});
