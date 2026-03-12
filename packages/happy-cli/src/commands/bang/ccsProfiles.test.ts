import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Mock fs module
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

import { readCcsProfiles, getCurrentCcsProfile, getInstancePath } from './ccsProfiles';

const ccsDir = join(homedir(), '.ccs');

describe('getInstancePath', () => {
    it('should return correct path for a profile name', () => {
        const result = getInstancePath('work');
        expect(result).toBe(join(ccsDir, 'instances', 'work'));
    });

    it('should sanitize profile names', () => {
        const result = getInstancePath('My Account!');
        expect(result).toBe(join(ccsDir, 'instances', 'my-account-'));
    });
});

describe('readCcsProfiles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.CCS_DIR;
        delete process.env.CCS_HOME;
    });

    it('should return empty when CCS directory does not exist', () => {
        mockExistsSync.mockReturnValue(false);

        const result = readCcsProfiles();
        expect(result.profiles).toEqual([]);
        expect(result.defaultProfile).toBeNull();
    });

    it('should read profiles from profiles.json', () => {
        mockExistsSync.mockImplementation((path: string) => {
            if (path === ccsDir) return true;
            if (path === join(ccsDir, 'profiles.json')) return true;
            return false;
        });

        mockReadFileSync.mockReturnValue(JSON.stringify({
            default: 'work',
            work: { type: 'account', context_mode: 'shared', context_group: 'default' },
            personal: { type: 'account', context_mode: 'isolated' },
        }));

        const result = readCcsProfiles();
        expect(result.defaultProfile).toBe('work');
        expect(result.profiles).toHaveLength(2);
        expect(result.profiles[0]).toEqual({
            name: 'work',
            instancePath: join(ccsDir, 'instances', 'work'),
            contextMode: 'shared',
            contextGroup: 'default',
        });
        expect(result.profiles[1]).toEqual({
            name: 'personal',
            instancePath: join(ccsDir, 'instances', 'personal'),
            contextMode: 'isolated',
            contextGroup: undefined,
        });
    });

    it('should handle malformed profiles.json gracefully', () => {
        mockExistsSync.mockImplementation((path: string) => {
            if (path === ccsDir) return true;
            if (path === join(ccsDir, 'profiles.json')) return true;
            return false;
        });
        mockReadFileSync.mockReturnValue('not json');

        const result = readCcsProfiles();
        expect(result.profiles).toEqual([]);
    });

    it('should respect CCS_DIR environment variable', () => {
        const customDir = '/custom/ccs';
        process.env.CCS_DIR = customDir;

        mockExistsSync.mockImplementation((path: string) => {
            if (path === customDir) return true;
            if (path === join(customDir, 'profiles.json')) return true;
            return false;
        });

        mockReadFileSync.mockReturnValue(JSON.stringify({
            myprofile: { type: 'account' },
        }));

        const result = readCcsProfiles();
        expect(result.profiles).toHaveLength(1);
        expect(result.profiles[0].name).toBe('myprofile');
        expect(result.profiles[0].instancePath).toBe(join(customDir, 'instances', 'myprofile'));
    });

    it('should read default from config.yaml when available', () => {
        mockExistsSync.mockImplementation((path: string) => {
            if (path === ccsDir) return true;
            if (path === join(ccsDir, 'profiles.json')) return true;
            if (path === join(ccsDir, 'config.yaml')) return true;
            return false;
        });

        // profiles.json has one default
        mockReadFileSync.mockImplementation((path: string) => {
            if (path === join(ccsDir, 'profiles.json')) {
                return JSON.stringify({
                    default: 'old-default',
                    work: { type: 'account' },
                });
            }
            if (path === join(ccsDir, 'config.yaml')) {
                return 'default: new-default\naccounts:\n  extra:\n';
            }
            return '';
        });

        const result = readCcsProfiles();
        // config.yaml default takes precedence
        expect(result.defaultProfile).toBe('new-default');
        // Merged profiles: 'work' from JSON + 'extra' from YAML
        expect(result.profiles.map(p => p.name)).toContain('work');
        expect(result.profiles.map(p => p.name)).toContain('extra');
    });
});

describe('getCurrentCcsProfile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.CLAUDE_CONFIG_DIR;
        delete process.env.CCS_DIR;
    });

    it('should return null when CLAUDE_CONFIG_DIR is not set', () => {
        expect(getCurrentCcsProfile()).toBeNull();
    });

    it('should return null when CLAUDE_CONFIG_DIR is not under CCS instances', () => {
        process.env.CLAUDE_CONFIG_DIR = '/some/other/path';
        mockExistsSync.mockReturnValue(false);
        expect(getCurrentCcsProfile()).toBeNull();
    });

    it('should detect active profile from CLAUDE_CONFIG_DIR', () => {
        const instancePath = join(ccsDir, 'instances', 'work');
        process.env.CLAUDE_CONFIG_DIR = instancePath;

        mockExistsSync.mockImplementation((path: string) => {
            if (path === ccsDir) return true;
            if (path === join(ccsDir, 'profiles.json')) return true;
            return false;
        });

        mockReadFileSync.mockReturnValue(JSON.stringify({
            work: { type: 'account' },
        }));

        expect(getCurrentCcsProfile()).toBe('work');
    });
});
