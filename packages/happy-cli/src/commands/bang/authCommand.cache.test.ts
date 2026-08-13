import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function writeConsoleProfile(root: string, fetchedAt: number): void {
    const ccsDir = join(root, 'ccs');
    const instancePath = join(ccsDir, 'instances', 'work');
    const happyHome = join(root, 'happy');
    mkdirSync(instancePath, { recursive: true });
    mkdirSync(happyHome, { recursive: true });
    writeFileSync(join(ccsDir, 'profiles.json'), JSON.stringify({ work: { type: 'account' } }));
    writeFileSync(join(instancePath, '.credentials.json'), JSON.stringify({
        claudeAiOauth: { accessToken: 'claude-token' },
    }));
    writeFileSync(join(happyHome, 'usage-cache.json'), JSON.stringify({
        version: 1,
        claude: {
            [instancePath]: {
                fetchedAt,
                data: {
                    five_hour: { utilization: 91, resets_at: '2030-01-01T00:00:00.000Z' },
                    seven_day: { utilization: 10, resets_at: '2030-01-07T00:00:00.000Z' },
                },
            },
        },
        codex: {},
    }));
    process.env.CCS_DIR = ccsDir;
    process.env.HAPPY_HOME_DIR = happyHome;
}

function writeCodexConsoleProfile(root: string, primaryFetchedAt: number, secondaryFetchedAt: number | null): void {
    const happyHome = join(root, 'happy');
    const codexHome = join(happyHome, 'auth', 'codex', 'instances', 'work');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'codex-token' } }));
    writeFileSync(join(happyHome, 'usage-cache.json'), JSON.stringify({
        version: 1,
        claude: {},
        codex: {
            [codexHome]: {
                fetchedAt: primaryFetchedAt,
                data: {
                    primaryWindow: { usedPercent: 23, resetAt: 1893456000, fetchedAt: primaryFetchedAt },
                    ...(secondaryFetchedAt == null ? {} : {
                        secondaryWindow: { usedPercent: 11, resetAt: 1893974400, fetchedAt: secondaryFetchedAt },
                    }),
                },
            },
        },
    }));
    process.env.HAPPY_HOME_DIR = happyHome;
}

function writeCodexSwitchProfiles(root: string): { workHome: string; personalHome: string } {
    const happyHome = join(root, 'happy');
    const instances = join(happyHome, 'auth', 'codex', 'instances');
    const workHome = join(instances, 'work');
    const personalHome = join(instances, 'personal');
    mkdirSync(workHome, { recursive: true });
    mkdirSync(personalHome, { recursive: true });
    writeFileSync(join(workHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'work-token' } }));
    writeFileSync(join(personalHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'personal-token' } }));
    writeFileSync(join(instances, 'config.yaml'), 'default: work\n');
    process.env.HAPPY_HOME_DIR = happyHome;
    process.env.CODEX_HOME = workHome;
    return { workHome, personalHome };
}

function consoleContext(): BangCommandContext & {
    client: { sendSessionEvent: ReturnType<typeof vi.fn> };
} {
    return {
        isConsoleSession: true,
        client: { sendSessionEvent: vi.fn() },
    } as unknown as BangCommandContext & {
        client: { sendSessionEvent: ReturnType<typeof vi.fn> };
    };
}

describe('console account switch live usage', () => {
    let root: string;

    beforeEach(() => {
        vi.resetModules();
        fetchMock.mockReset();
        process.env = { ...originalEnv };
        root = mkdtempSync(join(tmpdir(), 'happy-auth-cache-'));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        process.env = { ...originalEnv };
        vi.resetModules();
    });

    it('queries account usage even when a fresh cache exists', async () => {
        writeConsoleProfile(root, Date.now() - 4 * 60 * 1000);
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                five_hour: { utilization: 23, resets_at: '2030-01-01T00:00:00.000Z' },
                seven_day: { utilization: 10, resets_at: '2030-01-07T00:00:00.000Z' },
            }),
            text: async () => '',
        });
        const { handleAuthAllBangCommand } = await import('./authCommand');

        const result = await handleAuthAllBangCommand('', consoleContext());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const options = result.suggestions?.join('\n');
        expect(options).toContain('5h:23%');
        expect(options).toContain('7d:10%');
        expect(options).not.toContain('5h:91%');
        const cache = JSON.parse(readFileSync(join(root, 'happy', 'usage-cache.json'), 'utf8'));
        expect(Object.values(cache.claude)[0]).toMatchObject({
            data: { five_hour: { utilization: 91 } },
        });
    });

    it('queries account usage when the cache is older than five minutes', async () => {
        writeConsoleProfile(root, Date.now() - 5 * 60 * 1000 - 1);
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                five_hour: { utilization: 23, resets_at: '2030-01-01T00:00:00.000Z' },
                seven_day: { utilization: 10, resets_at: '2030-01-07T00:00:00.000Z' },
            }),
            text: async () => '',
        });
        const { handleAuthAllBangCommand } = await import('./authCommand');

        const result = await handleAuthAllBangCommand('', consoleContext());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.suggestions?.join('\n')).toContain('5h:23%');
        expect(result.suggestions?.join('\n')).not.toContain('5h:91%');
    });

    it('publishes the account-query notice before waiting for the final list', async () => {
        writeConsoleProfile(root, Date.now() - 6 * 60 * 1000);
        let releaseFetch: (value: unknown) => void = () => {
            throw new Error('fetch release was not initialized');
        };
        fetchMock.mockReturnValueOnce(new Promise(resolve => { releaseFetch = resolve; }));
        const { handleAuthAllBangCommand } = await import('./authCommand');
        const ctx = consoleContext();

        const pending = handleAuthAllBangCommand('', ctx);
        await vi.waitFor(() => {
            expect(ctx.client.sendSessionEvent).toHaveBeenCalledWith({
                type: 'message',
                message: '⏳ 账号信息查询中',
            });
        });
        releaseFetch({
            ok: true,
            json: async () => ({
                five_hour: { utilization: 23, resets_at: '2030-01-01T00:00:00.000Z' },
                seven_day: { utilization: 10, resets_at: '2030-01-07T00:00:00.000Z' },
            }),
            text: async () => '',
        });
        const result = await pending;
        expect(result.suggestions?.join('\n')).toContain('5h:23%');
    });

    it('does not substitute an aged cache when the direct query fails', async () => {
        writeConsoleProfile(root, Date.now() - 6 * 60 * 1000);
        fetchMock.mockRejectedValueOnce(new Error('network down'));
        const { handleAuthAllBangCommand } = await import('./authCommand');

        const result = await handleAuthAllBangCommand('', consoleContext());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const options = result.suggestions?.join('\n');
        expect(options).not.toContain('5h:91%');
        expect(options).not.toContain('7d:10%');
        expect(options).toContain('用量未知');
    });

    it('does not carry a cached Codex window into the live menu result', async () => {
        writeCodexConsoleProfile(root, Date.now() - 60_000, Date.now() - 6 * 60_000);
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                plan_type: 'pro',
                rate_limit: {
                    primary_window: {
                        used_percent: 17,
                        reset_at: 1893456000,
                        limit_window_seconds: 18_000,
                    },
                    secondary_window: null,
                },
                code_review_rate_limit: null,
            }),
            text: async () => '',
        });
        const { handleAuthAllBangCommand } = await import('./authCommand');

        const result = await handleAuthAllBangCommand('--codex', consoleContext());
        const options = result.suggestions?.join('\n');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(options).toContain('5h:17%');
        expect(options).toContain('7d:未知');
        expect(options).not.toContain('5h:23%');
        expect(options).not.toContain('7d:11%');
    });

    it('requeries an ambiguous old single-primary cache and renders a duration-proven 7d window', async () => {
        writeCodexConsoleProfile(root, Date.now() - 60_000, null);
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                plan_type: 'pro',
                rate_limit: {
                    primary_window: {
                        used_percent: 27,
                        reset_at: 1893974400,
                        limit_window_seconds: 604800,
                    },
                    secondary_window: null,
                },
                code_review_rate_limit: null,
            }),
            text: async () => '',
        });
        const { handleAuthAllBangCommand } = await import('./authCommand');

        const result = await handleAuthAllBangCommand('--codex', consoleContext());
        const options = result.suggestions?.join('\n');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(options).toContain('5h:未知');
        expect(options).toContain('7d:27%');
        expect(options).toContain('取0m');
    });

    it('defers a Codex session switch until the replacement client is ready', async () => {
        const { workHome } = writeCodexSwitchProfiles(root);
        const { handleAuthBangCommand } = await import('./authCommand');
        const ctx = {
            ...consoleContext(),
            isConsoleSession: false,
            flavor: 'codex' as const,
            deferCodexProfileSwitch: true,
        } as BangCommandContext;

        const result = await handleAuthBangCommand('personal', ctx);

        expect(result.action).toBe('restart-session');
        expect(result.restartProfile).toBe('personal');
        expect(process.env.CODEX_HOME).toBe(workHome);
        expect(readFileSync(join(root, 'happy', 'auth', 'codex', 'instances', 'config.yaml'), 'utf8'))
            .toContain('default: work');
        expect(Array.isArray(result.message) ? result.message.join('\n') : result.message)
            .toContain('正在切换到 "personal"');
    });
});
