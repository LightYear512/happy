import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Mock fs — must include all fs functions used transitively
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockWatch = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    watch: mockWatch,
}));

// Mock logger
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { handleAuthBangCommand } from './authCommand';
import type { BangCommandContext, BangCommandResult } from './types';

const ccsDir = join(homedir(), '.ccs');

/** Join string | string[] to a single string for contains checks. */
function joinMsg(result: BangCommandResult): string {
    if (!result.message) return '';
    return Array.isArray(result.message) ? result.message.join('\n') : result.message;
}

/** Create a minimal mock context */
function createMockContext(overrides: Partial<BangCommandContext> = {}): BangCommandContext {
    return {
        client: { sendSessionEvent: vi.fn(), sendCodexMessage: vi.fn() } as any,
        session: { clearSessionId: vi.fn() } as any,
        messageQueue: { pushIsolateAndClear: vi.fn() } as any,
        currentEnhancedMode: { permissionMode: 'default' as const },
        mode: 'remote' as const,
        ...overrides,
    };
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
        // Default: writeFileSync is a no-op
        mockWriteFileSync.mockReturnValue(undefined);
        // Default: watch returns a mock watcher
        mockWatch.mockReturnValue({ on: vi.fn(), close: vi.fn() });
    });

    afterEach(() => {
        if (savedConfigDir !== undefined) {
            process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
        } else {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
    });

    describe('!auth (list profiles)', () => {
        it('should show message when no CCS profiles exist', async () => {
            mockExistsSync.mockReturnValue(false);

            const result = await handleAuthBangCommand('', createMockContext());
            expect(result.action).toBe('none');
            expect(joinMsg(result)).toContain('未找到 CCS 配置');
        });

        it('should list available profiles', async () => {
            mockCcsProfiles(
                { work: { type: 'account' }, personal: { type: 'account' } },
                'work'
            );

            const result = await handleAuthBangCommand('', createMockContext());
            expect(result.action).toBe('none');
            const msg = joinMsg(result);
            expect(msg).toContain('work');
            expect(msg).toContain('personal');
        });

        it('should mark current profile with ● when CLAUDE_CONFIG_DIR is set', async () => {
            mockCcsProfiles(
                { work: { type: 'account' }, personal: { type: 'account' } },
                'work'
            );
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('', createMockContext());
            expect(joinMsg(result)).toContain('●');
        });

        it('should show no-profile message when no profile is active', async () => {
            mockCcsProfiles({ work: { type: 'account' } });

            const result = await handleAuthBangCommand('', createMockContext());
            const msg = joinMsg(result);
            // No CLAUDE_CONFIG_DIR means no current profile — new code shows "当前无 CCS 配置"
            expect(msg).toContain('当前无 CCS 配置');
            expect(msg).toContain('work');
        });
    });

    describe('!auth <name> (switch profile)', () => {
        it('should switch to a valid profile', async () => {
            mockCcsProfiles({ work: { type: 'account' } });

            const result = await handleAuthBangCommand('work', createMockContext());
            expect(result.action).toBe('restart-session');
            expect(joinMsg(result)).toContain('已切换到 "work"');
            expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(ccsDir, 'instances', 'work'));
        });

        it('should skip switch when already on same profile', async () => {
            mockCcsProfiles({ work: { type: 'account' } });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('work', createMockContext());
            expect(result.action).toBe('none');
            expect(joinMsg(result)).toContain('当前已是');
        });

        it('should error for non-existent profile', async () => {
            mockCcsProfiles({ work: { type: 'account' } });

            const result = await handleAuthBangCommand('nonexistent', createMockContext());
            expect(result.action).toBe('none');
            expect(joinMsg(result)).toContain('未找到配置');
        });

        it('should include profile names in not-found error', async () => {
            mockCcsProfiles({ workspace: { type: 'account' } });

            const result = await handleAuthBangCommand('work', createMockContext());
            // Profile not found — error message mentions the queried name
            expect(joinMsg(result)).toContain('work');
        });

        it('should error when switching to unrecognised "default" keyword', async () => {
            mockCcsProfiles({ work: { type: 'account' } });

            // New code has no special "default" keyword — treated as unknown profile
            const result = await handleAuthBangCommand('default', createMockContext());
            expect(result.action).toBe('none');
            expect(joinMsg(result)).toContain('未找到配置');
        });

        it('should error when instance directory is not initialized', async () => {
            // Profile exists in profiles.json but instance dir doesn't
            mockExistsSync.mockImplementation((path: string) => {
                if (path === ccsDir) return true;
                if (path === join(ccsDir, 'profiles.json')) return true;
                // Instance directory does NOT exist
                return false;
            });

            mockReadFileSync.mockReturnValue(JSON.stringify({
                work: { type: 'account' },
            }));

            const result = await handleAuthBangCommand('work', createMockContext());
            expect(result.action).toBe('none');
            expect(joinMsg(result)).toContain('未初始化');
        });

        it('should redirect to !auth-all when in console session', async () => {
            mockCcsProfiles({ work: { type: 'account' } });

            const result = await handleAuthBangCommand('work', createMockContext({ isConsoleSession: true }));
            expect(result.action).toBe('none');
            expect(joinMsg(result)).toContain('auth-all');
        });
    });
});
