import { describe, it, expect } from 'vitest';
import { isBangCommand, buildConsoleWelcome, SEPARATOR } from './dispatcher';

describe('isBangCommand', () => {
    it('should detect bang commands', () => {
        expect(isBangCommand('!auth')).toBe(true);
        expect(isBangCommand('!auth work')).toBe(true);
        expect(isBangCommand('!status')).toBe(true);
    });

    it('should reject non-bang messages', () => {
        expect(isBangCommand('hello')).toBe(false);
        expect(isBangCommand('/compact')).toBe(false);
        expect(isBangCommand('')).toBe(false);
    });

    it('should reject lone exclamation mark or space after it', () => {
        expect(isBangCommand('!')).toBe(false);
        expect(isBangCommand('! auth')).toBe(false);
    });

    it('should handle whitespace around the command', () => {
        expect(isBangCommand('  !auth  ')).toBe(true);
        expect(isBangCommand('\t!auth')).toBe(true);
    });

    it('should not match exclamation in the middle of text', () => {
        expect(isBangCommand('hello !auth')).toBe(false);
        expect(isBangCommand('run !status now')).toBe(false);
    });
});

describe('buildConsoleWelcome', () => {
    it('returns a BangCommandResult with message array', () => {
        const result = buildConsoleWelcome();
        const messages = result.message as string[];
        expect(Array.isArray(messages)).toBe(true);
        expect(messages.length).toBeGreaterThan(0);
        for (const msg of messages) {
            expect(typeof msg).toBe('string');
        }
    });

    it('starts with console title', () => {
        const messages = buildConsoleWelcome().message as string[];
        expect(messages[0]).toContain('控制台');
    });

    it('contains separator lines', () => {
        const messages = buildConsoleWelcome().message as string[];
        const separators = messages.filter(m => m === SEPARATOR);
        expect(separators.length).toBeGreaterThanOrEqual(2);
    });

    it('includes commands available in console (not sessionOnly)', () => {
        const messages = buildConsoleWelcome().message as string[];
        const joined = messages.join('\n');
        // These are consoleOnly or shared commands
        expect(joined).toContain('!auth-all');
        expect(joined).toContain('!usage');
        expect(joined).toContain('!login');
        // sessionOnly commands should NOT appear
        expect(joined).not.toMatch(/!restart(?!-all)/);
        // !auth is sessionOnly — must NOT appear in console welcome
        expect(joined).not.toMatch(/^!auth\b(?!-all)/m);
    });

    it('lists login/usage/auth-all in registry order with codex variants interleaved', () => {
        const messages = buildConsoleWelcome().message as string[];
        const indices = {
            login: messages.findIndex(m => /^!login\b(?! --codex)/.test(m)),
            loginCodex: messages.findIndex(m => m.startsWith('!login --codex')),
            usage: messages.findIndex(m => /^!usage\b(?! --codex)/.test(m)),
            usageCodex: messages.findIndex(m => m.startsWith('!usage --codex')),
            authAll: messages.findIndex(m => /^!auth-all\b(?! --codex)/.test(m)),
            authAllCodex: messages.findIndex(m => m.startsWith('!auth-all --codex')),
            help: messages.findIndex(m => m.startsWith('!help')),
        };
        for (const [k, v] of Object.entries(indices)) {
            expect(v, `${k} not found`).toBeGreaterThanOrEqual(0);
        }
        expect(indices.login).toBeLessThan(indices.loginCodex);
        expect(indices.loginCodex).toBeLessThan(indices.usage);
        expect(indices.usage).toBeLessThan(indices.usageCodex);
        expect(indices.usageCodex).toBeLessThan(indices.authAll);
        expect(indices.authAll).toBeLessThan(indices.authAllCodex);
        expect(indices.authAllCodex).toBeLessThan(indices.help);
    });

    it('shows auth-all in the welcome listing (not hidden)', () => {
        const messages = buildConsoleWelcome().message as string[];
        const joined = messages.join('\n');
        expect(joined).toContain('!auth-all');
        expect(joined).toContain('!auth-all --codex');
    });

    it('suggestions list console-available commands', () => {
        const suggestions = buildConsoleWelcome().suggestions!;
        expect(suggestions).toContain('!auth-all');
        expect(suggestions).toContain('!auth-all --codex');
        expect(suggestions).toContain('!login');
        expect(suggestions).toContain('!login --codex');
        expect(suggestions).toContain('!usage');
        expect(suggestions).toContain('!usage --codex');
        expect(suggestions).toContain('!help');
        // !auth is sessionOnly — should NOT be in console suggestions
        expect(suggestions).not.toContain('!auth');
    });

    it('does not include hidden commands', () => {
        const messages = buildConsoleWelcome().message as string[];
        const joined = messages.join('\n');
        expect(joined).not.toContain('!test');
    });

    it('ends with non-bang message warning', () => {
        const messages = buildConsoleWelcome().message as string[];
        expect(messages[messages.length - 1]).toContain('普通消息');
    });

    it('includes suggestion buttons for console commands', () => {
        const result = buildConsoleWelcome();
        expect(result.suggestions).toBeDefined();
        expect(result.suggestions!.length).toBeGreaterThan(0);
        expect(result.suggestions!.every(s => s.startsWith('!'))).toBe(true);
    });
});

describe('SEPARATOR', () => {
    it('is a non-empty string of box-drawing characters', () => {
        expect(typeof SEPARATOR).toBe('string');
        expect(SEPARATOR.length).toBeGreaterThan(0);
    });
});
