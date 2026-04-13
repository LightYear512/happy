import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Mock fs
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        existsSync: mockExistsSync,
        readFileSync: mockReadFileSync,
        writeFileSync: mockWriteFileSync,
    };
});

// Mock logger
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

import { handleAuthBangCommand } from './authCommand';
import type { BangCommandContext } from './types';

const ccsDir = join(homedir(), '.ccs');

/** Create a minimal mock context */
function createMockContext(): BangCommandContext {
    return {
        client: {} as any,
        session: { clearSessionId: vi.fn() } as any,
        messageQueue: { pushIsolateAndClear: vi.fn() } as any,
        currentEnhancedMode: { permissionMode: 'default' as const },
    };
}

/** Flatten result.message (string or string[]) into a single string for assertion */
function flatMsg(message: string | string[]): string {
    return Array.isArray(message) ? message.join('\n') : message;
}

/** Set up mock filesystem with given profiles */
function mockCcsProfiles(profiles: Record<string, any>, defaultProfile?: string) {
    const data: Record<string, any> = { ...profiles };
    if (defaultProfile) data.default = defaultProfile;

    mockExistsSync.mockImplementation((path: string) => {
        if (path === ccsDir) return true;
        if (path === join(ccsDir, 'profiles.json')) return true;
        // Instance directories exist for all profiles
        for (const name of Object.keys(profiles)) {
            if (path === join(ccsDir, 'instances', name)) return true;
        }
        return false;
    });

    mockReadFileSync.mockReturnValue(JSON.stringify(data));
}

describe('handleAuthBangCommand', () => {
    let savedConfigDir: string | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
        delete process.env.CLAUDE_CONFIG_DIR;
        delete process.env.CCS_DIR;
    });

    afterEach(() => {
        if (savedConfigDir !== undefined) {
            process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
        } else {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
    });

    describe('!auth (list profiles)', () => {
        it('should show current account as isolated when not in a shared group', async () => {
            mockCcsProfiles({ work: { type: 'account' } });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('', createMockContext());
            expect(result.action).toBe('none');
            const msg = flatMsg(result.message);
            expect(msg).toContain('独立');
        });

        it('should show no active profile when CLAUDE_CONFIG_DIR is not set', async () => {
            mockCcsProfiles({ work: { type: 'account' } });

            const result = await handleAuthBangCommand('', createMockContext());
            const msg = flatMsg(result.message);
            expect(msg).toMatch(/当前无 CCS|No CCS/);
            expect(msg).toContain('work');
        });

        it('should list other shared profiles when in shared mode', async () => {
            mockCcsProfiles({
                work: { type: 'account', context_mode: 'shared' },
                personal: { type: 'account', context_mode: 'shared' },
            });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('', createMockContext());
            expect(result.action).toBe('none');
            const msg = flatMsg(result.message);
            expect(msg).toContain('共享账号');
            expect(msg).toContain('work');
            expect(msg).toContain('personal');
            expect(msg).toContain('!auth');
        });

        it('should show no switchable when alone in shared mode', async () => {
            mockCcsProfiles({
                work: { type: 'account', context_mode: 'shared' },
            });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('', createMockContext());
            const msg = flatMsg(result.message);
            // Only one shared profile — shows the current profile and no switchable
            expect(msg).toContain('work');
            expect(msg).toContain('共享账号');
        });
    });

    describe('!auth <name> (switch profile)', () => {
        it('should switch between shared profiles', async () => {
            mockCcsProfiles({
                work: { type: 'account', context_mode: 'shared' },
                personal: { type: 'account', context_mode: 'shared' },
            });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('personal', createMockContext());
            expect(result.action).toBe('restart-session');
            const msg = flatMsg(result.message);
            expect(msg).toMatch(/切换到 "personal"|Switched to "personal"/);
            expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(ccsDir, 'instances', 'personal'));
        });

        it('should reject switching to an isolated profile', async () => {
            mockCcsProfiles({
                work: { type: 'account', context_mode: 'shared' },
                isolated: { type: 'account' },
            });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('isolated', createMockContext());
            expect(result.action).toBe('none');
            const msg = flatMsg(result.message);
            expect(msg).toMatch(/无法切换|Cannot switch/);
        });

        it('should reject switching when current profile is not shared', async () => {
            mockCcsProfiles({
                work: { type: 'account' },
                personal: { type: 'account', context_mode: 'shared' },
            });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('personal', createMockContext());
            expect(result.action).toBe('none');
            const msg = flatMsg(result.message);
            expect(msg).toMatch(/无法切换|Cannot switch/);
            expect(msg).toMatch(/"work".*独立|"work" is isolated/);
        });

        it('should skip switch when already on same profile', async () => {
            mockCcsProfiles({
                work: { type: 'account', context_mode: 'shared' },
            });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('work', createMockContext());
            expect(result.action).toBe('none');
            const msg = flatMsg(result.message);
            expect(msg).toMatch(/当前已是|Already using/);
        });

        it('should error for non-existent profile', async () => {
            mockCcsProfiles({ work: { type: 'account' } });

            const result = await handleAuthBangCommand('nonexistent', createMockContext());
            expect(result.action).toBe('none');
            const msg = flatMsg(result.message);
            expect(msg).toMatch(/未找到|not found/i);
        });

        it('should error when instance directory is not initialized', async () => {
            mockExistsSync.mockImplementation((path: string) => {
                if (path === ccsDir) return true;
                if (path === join(ccsDir, 'profiles.json')) return true;
                // Instance directory for 'personal' does NOT exist
                if (path === join(ccsDir, 'instances', 'work')) return true;
                return false;
            });

            mockReadFileSync.mockReturnValue(JSON.stringify({
                work: { type: 'account', context_mode: 'shared' },
                personal: { type: 'account', context_mode: 'shared' },
            }));
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('personal', createMockContext());
            expect(result.action).toBe('none');
            const msg = flatMsg(result.message);
            expect(msg).toMatch(/未初始化|not initialized/i);
        });
    });

    describe('--codex flag rejection (normal session)', () => {
        it('rejects --codex when ctx is not a console session', async () => {
            mockCcsProfiles({
                work: { type: 'account', context_mode: 'shared' },
            });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('xxx --codex', createMockContext());
            expect(result.action).toBe('none');
            const msg = flatMsg(result.message);
            expect(msg).toContain('普通会话不支持 --codex');
        });

        it('accepts --codex in console session', async () => {
            // Console mode + --codex should NOT be rejected by the codex-flag guard.
            // (It may still error on other grounds — we only assert the guard isn't tripped.)
            const consoleCtx: BangCommandContext = { ...createMockContext(), isConsoleSession: true };
            const result = await handleAuthBangCommand('--codex', consoleCtx);
            const msg = flatMsg(result.message);
            expect(msg).not.toContain('普通会话不支持 --codex');
        });
    });
});
