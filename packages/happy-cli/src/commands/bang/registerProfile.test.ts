import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { registerProfile } from './authCreateCommand';

/** Create a unique temp directory and set CCS_DIR to point to it. */
function createTempCcsDir(): string {
    const dir = join(tmpdir(), `ccs-test-${randomBytes(4).toString('hex')}`);
    mkdirSync(dir, { recursive: true });
    process.env.CCS_DIR = dir;
    return dir;
}

describe('registerProfile — YAML text manipulation', () => {
    let ccsDir: string;
    const originalCcsDir = process.env.CCS_DIR;

    beforeEach(() => {
        ccsDir = createTempCcsDir();
    });

    afterEach(() => {
        if (originalCcsDir) {
            process.env.CCS_DIR = originalCcsDir;
        } else {
            delete process.env.CCS_DIR;
        }
        if (existsSync(ccsDir)) {
            rmSync(ccsDir, { recursive: true, force: true });
        }
    });

    it('creates config.yaml from scratch when file does not exist', () => {
        registerProfile('test-account', 'shared', 'default');

        const configPath = join(ccsDir, 'config.yaml');
        expect(existsSync(configPath)).toBe(true);

        const content = readFileSync(configPath, 'utf-8');
        expect(content).toContain('accounts:');
        expect(content).toContain('  test-account:');
        expect(content).toContain('    context_mode: shared');
        expect(content).toContain('    context_group: default');
        expect(content).toContain('    continuity_mode: standard');
        expect(content).toContain('    created:');
        expect(content).toContain('    last_used: null');
        expect(content).toContain('version: 8');
    });

    it('appends new account to existing config.yaml with accounts section', () => {
        const configPath = join(ccsDir, 'config.yaml');
        writeFileSync(configPath, [
            '# CCS config',
            'version: 8',
            '',
            'accounts:',
            '  existing-user:',
            '    created: "2026-01-01T00:00:00.000Z"',
            '    last_used: null',
            '    context_mode: shared',
            '    continuity_mode: standard',
            '',
            'settings:',
            '  theme: dark',
        ].join('\n'), 'utf-8');

        registerProfile('new-user', 'isolated');

        const content = readFileSync(configPath, 'utf-8');
        // Both accounts should exist
        expect(content).toContain('  existing-user:');
        expect(content).toContain('  new-user:');
        expect(content).toContain('    context_mode: isolated');
        // settings section should still be intact after accounts
        expect(content).toContain('settings:');
        expect(content).toContain('  theme: dark');
    });

    it('appends accounts section when config.yaml exists but has no accounts', () => {
        const configPath = join(ccsDir, 'config.yaml');
        writeFileSync(configPath, [
            'version: 8',
            '',
            'settings:',
            '  theme: dark',
        ].join('\n'), 'utf-8');

        registerProfile('first-user', 'shared', 'default');

        const content = readFileSync(configPath, 'utf-8');
        expect(content).toContain('accounts:');
        expect(content).toContain('  first-user:');
        expect(content).toContain('settings:');
    });

    it('inserts account before next top-level key', () => {
        const configPath = join(ccsDir, 'config.yaml');
        writeFileSync(configPath, [
            'version: 8',
            'accounts:',
            '  alpha:',
            '    created: "2026-01-01T00:00:00.000Z"',
            '    last_used: null',
            '    context_mode: shared',
            'settings:',
            '  log_level: debug',
        ].join('\n'), 'utf-8');

        registerProfile('beta', 'shared');

        const content = readFileSync(configPath, 'utf-8');
        const lines = content.split('\n');
        const betaIdx = lines.findIndex(l => l.includes('beta:'));
        const settingsIdx = lines.findIndex(l => l.startsWith('settings:'));
        // beta should be inserted before settings
        expect(betaIdx).toBeGreaterThan(-1);
        expect(settingsIdx).toBeGreaterThan(betaIdx);
    });

    it('omits context_group when not provided', () => {
        registerProfile('no-group', 'isolated');

        const content = readFileSync(join(ccsDir, 'config.yaml'), 'utf-8');
        expect(content).toContain('  no-group:');
        expect(content).not.toContain('context_group');
    });

    it('includes context_group when provided', () => {
        registerProfile('with-group', 'shared', 'my-team');

        const content = readFileSync(join(ccsDir, 'config.yaml'), 'utf-8');
        expect(content).toContain('    context_group: my-team');
    });

    it('handles config.yaml with trailing newline', () => {
        const configPath = join(ccsDir, 'config.yaml');
        writeFileSync(configPath, 'version: 8\n\naccounts:\n  old:\n    created: "2026-01-01"\n    last_used: null\n    context_mode: shared\n\n', 'utf-8');

        registerProfile('new-account', 'shared');

        const content = readFileSync(configPath, 'utf-8');
        expect(content).toContain('  old:');
        expect(content).toContain('  new-account:');
    });

    it('handles config.yaml with existing accounts and other sections', () => {
        const configPath = join(ccsDir, 'config.yaml');
        writeFileSync(configPath, [
            'version: 8',
            'accounts:',
            '  primary:',
            '    created: "2026-01-01"',
            '    last_used: null',
            '    context_mode: shared',
            'settings:',
            '  theme: dark',
        ].join('\n'), 'utf-8');

        registerProfile('secondary', 'shared');

        const content = readFileSync(configPath, 'utf-8');
        expect(content).toContain('primary:');
        expect(content).toContain('secondary:');
        // settings section should be intact (js-yaml round-trips all non-comment data)
        expect(content).toContain('settings:');
        expect(content).toContain('theme: dark');
    });

    it('created timestamp is valid ISO string', () => {
        registerProfile('ts-test', 'shared');

        const content = readFileSync(join(ccsDir, 'config.yaml'), 'utf-8');
        const match = content.match(/created: "([^"]+)"/);
        expect(match).not.toBeNull();
        const date = new Date(match![1]);
        expect(date.getTime()).not.toBeNaN();
        // Should be recent (within last minute)
        expect(Date.now() - date.getTime()).toBeLessThan(60_000);
    });
});
