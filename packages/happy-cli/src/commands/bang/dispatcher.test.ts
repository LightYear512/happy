import { describe, it, expect } from 'vitest';
import { isBangCommand, executeBangCommand, buildSessionWelcome, buildConsoleWelcome, SEPARATOR } from './dispatcher';
import type { BangCommandContext } from './types';

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

// ---------------------------------------------------------------------------
// dispatcher dispatch logic
// We exercise paths that DO NOT cross into real handler implementations
// (auth/usage/login/restart all read filesystem state and would require a
// live env). These tests cover the parts of the dispatcher itself: alias
// resolution, mode gating, help generation, unknown command, !cancel guard.
// ---------------------------------------------------------------------------

/** Minimal context that satisfies the BangCommandContext shape — no real I/O. */
function makeCtx(opts: { isConsoleSession?: boolean } = {}): BangCommandContext {
    return {
        // Only sendSessionEvent might be invoked (for loadingMsg) — provide a no-op.
        client: { sendSessionEvent: () => {} } as unknown as BangCommandContext['client'],
        session: null,
        messageQueue: undefined as unknown as BangCommandContext['messageQueue'],
        currentEnhancedMode: undefined as unknown as BangCommandContext['currentEnhancedMode'],
        isConsoleSession: opts.isConsoleSession ?? false,
        flavor: 'claude',
        mode: 'remote',
    };
}

function joinMsg(r: { message: string | string[] }): string {
    return Array.isArray(r.message) ? r.message.join('\n') : r.message;
}

describe('executeBangCommand — built-in paths', () => {
    it('!help in a session lists session-available commands', async () => {
        const r = await executeBangCommand('!help', makeCtx({ isConsoleSession: false }));
        expect(r.action).toBe('none');
        const text = joinMsg(r);
        expect(text).toContain('📖 快捷命令');
        expect(text).toContain(SEPARATOR);
        // sessionOnly: !restart should appear; consoleOnly !restart-all should be hidden
        expect(text).toContain('!restart');
        expect(text).not.toContain('!restart-all');
        expect(r.suggestions).toContain('!help');
        expect(r.suggestions).toContain('!restart');
    });

    it('!help in console lists console-available commands', async () => {
        const r = await executeBangCommand('!help', makeCtx({ isConsoleSession: true }));
        const text = joinMsg(r);
        // consoleOnly !auth-all should appear, sessionOnly !restart should not
        expect(text).toContain('!auth-all');
        expect(text).not.toMatch(/!restart\b(?!-)/);  // exact !restart, not !restart-all
    });

    it('!h alias resolves to !help', async () => {
        const r = await executeBangCommand('!h', makeCtx());
        const text = joinMsg(r);
        expect(text).toContain('📖 快捷命令');
    });

    it('rejects unknown bang command with available list', async () => {
        const r = await executeBangCommand('!nosuch', makeCtx());
        expect(r.action).toBe('none');
        const text = joinMsg(r);
        expect(text).toContain('未知命令');
        expect(text).toContain('!nosuch');
        // The "可用命令" line lists registry entries (auth/usage/login/restart/...);
        // !help is a built-in path so it lives in suggestions, not the listing line.
        expect(text).toContain('!auth');
        expect(text).toContain('!login');
        expect(r.suggestions).toEqual(['!help']);
    });

    it('rejects sessionOnly command in console mode', async () => {
        const r = await executeBangCommand('!restart', makeCtx({ isConsoleSession: true }));
        expect(r.action).toBe('none');
        const text = joinMsg(r);
        expect(text).toContain('!restart');
        expect(text).toContain('仅在会话中可用');
    });

    it('rejects consoleOnly command in normal session', async () => {
        const r = await executeBangCommand('!auth-all', makeCtx({ isConsoleSession: false }));
        expect(r.action).toBe('none');
        const text = joinMsg(r);
        expect(text).toContain('!auth-all');
        expect(text).toContain('仅在控制台中可用');
    });

    it('!cancel without active interactive session is a no-op', async () => {
        const r = await executeBangCommand('!cancel', makeCtx());
        expect(r.action).toBe('none');
        const text = joinMsg(r);
        expect(text).toContain('当前没有进行中的操作');
    });

    it('!取消 (Chinese alias for cancel) without active interactive session is a no-op', async () => {
        const r = await executeBangCommand('!取消', makeCtx());
        const text = joinMsg(r);
        expect(text).toContain('当前没有进行中的操作');
    });

    it('alias for unknown single letter falls through to unknown error', async () => {
        // 'x' is not in the alias table, not in commands; should hit unknown path.
        const r = await executeBangCommand('!x', makeCtx());
        const text = joinMsg(r);
        expect(text).toContain('未知命令');
    });

    it('command name is case-insensitive (!HELP works)', async () => {
        const r = await executeBangCommand('!HELP', makeCtx());
        const text = joinMsg(r);
        expect(text).toContain('📖 快捷命令');
    });
});

describe('buildSessionWelcome / buildConsoleWelcome', () => {
    it('session welcome offers session commands as suggestions', () => {
        const r = buildSessionWelcome();
        expect(r.action).toBe('none');
        expect(r.suggestions).toContain('!help');
        expect(r.suggestions).toContain('!restart');
        // consoleOnly excluded
        expect(r.suggestions).not.toContain('!restart-all');
        expect(r.suggestions).not.toContain('!auth-all');
    });

    it('console welcome lists console-available commands and excludes sessionOnly', () => {
        const r = buildConsoleWelcome();
        expect(r.action).toBe('none');
        const text = joinMsg(r);
        expect(text).toContain('🖥️ 控制台');
        expect(text).toContain(SEPARATOR);
        // sessionOnly !restart should be hidden from console welcome
        expect(text).not.toMatch(/!restart\b(?!-)/);
        // !help is built-in / always present
        expect(text).toContain('!help');
    });
});
