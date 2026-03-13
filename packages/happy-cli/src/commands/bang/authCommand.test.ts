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
            expect(result.message).toContain('isolated');
            expect(result.message).toContain('Isolated mode');
        });

        it('should show no active profile when CLAUDE_CONFIG_DIR is not set', async () => {
            mockCcsProfiles({ work: { type: 'account' } });

            const result = await handleAuthBangCommand('', createMockContext());
            expect(result.message).toContain('No CCS profile active');
            expect(result.message).toContain('work');
        });

        it('should list same-group profiles when in a shared group', async () => {
            mockCcsProfiles({
                work: { type: 'account', context_mode: 'shared', context_group: 'team' },
                personal: { type: 'account', context_mode: 'shared', context_group: 'team' },
                other: { type: 'account', context_mode: 'shared', context_group: 'solo' },
            });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('', createMockContext());
            expect(result.action).toBe('none');
            expect(result.message).toContain('Group "team"');
            expect(result.message).toContain('work (current)');
            expect(result.message).toContain('personal');
            // Should NOT show profile from a different group
            expect(result.message).not.toContain('other');
            expect(result.message).toContain('!auth <name>');
        });

        it('should show no switchable when alone in shared group', async () => {
            mockCcsProfiles({
                work: { type: 'account', context_mode: 'shared', context_group: 'team' },
            });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('', createMockContext());
            expect(result.message).toContain('No other accounts in this group');
        });
    });

    describe('!auth <name> (switch profile)', () => {
        it('should switch between profiles in the same shared group', async () => {
            mockCcsProfiles({
                work: { type: 'account', context_mode: 'shared', context_group: 'team' },
                personal: { type: 'account', context_mode: 'shared', context_group: 'team' },
            });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('personal', createMockContext());
            expect(result.action).toBe('restart-session');
            expect(result.message).toContain('Switched to "personal"');
            expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(ccsDir, 'instances', 'personal'));
        });

        it('should reject switching to a profile in a different group', async () => {
            mockCcsProfiles({
                work: { type: 'account', context_mode: 'shared', context_group: 'team' },
                other: { type: 'account', context_mode: 'shared', context_group: 'solo' },
            });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('other', createMockContext());
            expect(result.action).toBe('none');
            expect(result.message).toContain('Cannot switch');
            expect(result.message).toContain('group "team"');
            expect(result.message).toContain('group "solo"');
            // Should NOT have changed CLAUDE_CONFIG_DIR
            expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(ccsDir, 'instances', 'work'));
        });

        it('should reject switching to an isolated profile', async () => {
            mockCcsProfiles({
                work: { type: 'account', context_mode: 'shared', context_group: 'team' },
                isolated: { type: 'account' },
            });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('isolated', createMockContext());
            expect(result.action).toBe('none');
            expect(result.message).toContain('Cannot switch');
            expect(result.message).toContain('isolated');
        });

        it('should reject switching when current profile is not shared', async () => {
            mockCcsProfiles({
                work: { type: 'account' },
                personal: { type: 'account', context_mode: 'shared', context_group: 'team' },
            });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('personal', createMockContext());
            expect(result.action).toBe('none');
            expect(result.message).toContain('Cannot switch');
            expect(result.message).toContain('"work" is isolated');
        });

        it('should skip switch when already on same profile', async () => {
            mockCcsProfiles({
                work: { type: 'account', context_mode: 'shared', context_group: 'team' },
            });
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('work', createMockContext());
            expect(result.action).toBe('none');
            expect(result.message).toContain('Already using');
        });

        it('should error for non-existent profile', async () => {
            mockCcsProfiles({ work: { type: 'account' } });

            const result = await handleAuthBangCommand('nonexistent', createMockContext());
            expect(result.action).toBe('none');
            expect(result.message).toContain('not found');
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
                work: { type: 'account', context_mode: 'shared', context_group: 'team' },
                personal: { type: 'account', context_mode: 'shared', context_group: 'team' },
            }));
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('personal', createMockContext());
            expect(result.action).toBe('none');
            expect(result.message).toContain('not initialized');
        });
    });
});
