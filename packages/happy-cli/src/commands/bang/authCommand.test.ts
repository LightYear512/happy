import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Mock fs
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
}));

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
        it('should show warning when no CCS profiles exist', async () => {
            mockExistsSync.mockReturnValue(false);

            const result = await handleAuthBangCommand('', createMockContext());
            expect(result.action).toBe('none');
            expect(result.message).toContain('No CCS profiles found');
        });

        it('should list available profiles', async () => {
            mockCcsProfiles(
                { work: { type: 'account' }, personal: { type: 'account' } },
                'work'
            );

            const result = await handleAuthBangCommand('', createMockContext());
            expect(result.action).toBe('none');
            expect(result.message).toContain('work');
            expect(result.message).toContain('personal');
            expect(result.message).toContain('[default]');
        });

        it('should mark current profile when CLAUDE_CONFIG_DIR is set', async () => {
            mockCcsProfiles(
                { work: { type: 'account' }, personal: { type: 'account' } },
                'work'
            );
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');

            const result = await handleAuthBangCommand('', createMockContext());
            expect(result.message).toContain('(current)');
        });

        it('should show "default (current)" when no profile is active', async () => {
            mockCcsProfiles({ work: { type: 'account' } });

            const result = await handleAuthBangCommand('', createMockContext());
            expect(result.message).toContain('default (current)');
        });
    });

    describe('!auth <name> (switch profile)', () => {
        it('should switch to a valid profile', async () => {
            mockCcsProfiles({ work: { type: 'account' } });

            const result = await handleAuthBangCommand('work', createMockContext());
            expect(result.action).toBe('restart-session');
            expect(result.message).toContain('Switching to "work"');
            expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(ccsDir, 'instances', 'work'));
        });

        it('should skip switch when already on same profile', async () => {
            mockCcsProfiles({ work: { type: 'account' } });
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

        it('should suggest similar profile names', async () => {
            mockCcsProfiles({ workspace: { type: 'account' } });

            const result = await handleAuthBangCommand('work', createMockContext());
            expect(result.message).toContain('workspace');
        });

        it('should switch to default (unset CLAUDE_CONFIG_DIR)', async () => {
            process.env.CLAUDE_CONFIG_DIR = join(ccsDir, 'instances', 'work');
            mockCcsProfiles({ work: { type: 'account' } });

            const result = await handleAuthBangCommand('default', createMockContext());
            expect(result.action).toBe('restart-session');
            expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
        });

        it('should skip switch when already on default', async () => {
            // No CLAUDE_CONFIG_DIR set = already on default
            mockCcsProfiles({ work: { type: 'account' } });

            const result = await handleAuthBangCommand('default', createMockContext());
            expect(result.action).toBe('none');
            expect(result.message).toContain('Already using default');
        });

        it('should error when instance directory is not initialized', async () => {
            // Profile exists but instance dir doesn't
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
            expect(result.message).toContain('not initialized');
        });
    });
});
