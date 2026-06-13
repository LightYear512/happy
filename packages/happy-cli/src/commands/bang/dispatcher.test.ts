import { describe, it, expect } from 'vitest';
import { isBangCommand, buildConsoleWelcome, executeBangCommand, SEPARATOR } from './dispatcher';
import type { BangOptionSuggestion } from './types';

function optionLabel(option: BangOptionSuggestion): string {
    return typeof option === 'string' ? option : option.label;
}

describe('isBangCommand', () => {
    it('should detect bang commands', () => {
        expect(isBangCommand('!auth')).toBe(true);
        expect(isBangCommand('!auth work')).toBe(true);
        expect(isBangCommand('!status')).toBe(true);
    });

    it('should detect @ short aliases', () => {
        expect(isBangCommand('@a')).toBe(true);
        expect(isBangCommand('@h')).toBe(true);
        expect(isBangCommand('@u')).toBe(true);
        expect(isBangCommand('@reminder')).toBe(true);
        expect(isBangCommand('@reply-monitor')).toBe(true);
        expect(isBangCommand('@task-ack TM-2026-06-13T154603-354522Z-78772d21f1')).toBe(true);
        expect(isBangCommand('@task-dismiss TM-2026-06-13T154603-354522Z-78772d21f1')).toBe(true);
        expect(isBangCommand('A\n@reply-monitor | 回复监控开关')).toBe(true);
        expect(isBangCommand('2、@task-ack TM-1｜已处理，确认')).toBe(true);
        expect(isBangCommand('1、@reply-monitor｜回复监控开关')).toBe(true);
        expect(isBangCommand('• @reminder｜设置/取消提示')).toBe(true);
        expect(isBangCommand('@usage')).toBe(false);
    });

    it('should reject non-bang messages', () => {
        expect(isBangCommand('hello')).toBe(false);
        expect(isBangCommand('/compact')).toBe(false);
        expect(isBangCommand('请确认 @task-ack TM-1')).toBe(false);
        expect(isBangCommand('')).toBe(false);
    });

    it('should reject lone exclamation mark or space after it', () => {
        expect(isBangCommand('!')).toBe(false);
        expect(isBangCommand('! auth')).toBe(false);
        expect(isBangCommand('@')).toBe(true);
        expect(isBangCommand('@@')).toBe(true);
        expect(isBangCommand('@ auth')).toBe(false);
    });

    it('should handle whitespace around the command', () => {
        expect(isBangCommand('  !auth  ')).toBe(true);
        expect(isBangCommand('\t!auth')).toBe(true);
        expect(isBangCommand('  @h  ')).toBe(true);
    });

    it('should not match exclamation in the middle of text', () => {
        expect(isBangCommand('hello !auth')).toBe(false);
        expect(isBangCommand('run !status now')).toBe(false);
        expect(isBangCommand('hello @h')).toBe(false);
    });
});

describe('executeBangCommand aliases', () => {
    const ctx = {
        client: {} as never,
        session: null,
        messageQueue: {} as never,
        currentEnhancedMode: { permissionMode: 'default' } as never,
    };

    it('uses @ for short aliases', async () => {
        const help = await executeBangCommand('@h', ctx);
        expect((help.message as string[]).join('\n')).toContain('@h (!help)');

        expect(isBangCommand('@u-codex')).toBe(true);
        expect(isBangCommand('@aa-codex')).toBe(true);

        const oldShortAlias = await executeBangCommand('!h', ctx);
        expect((oldShortAlias.message as string[]).join('\n')).toContain('未知命令 "!h"');
    });

    it('shows htask toggles only in the ordinary @ quick menu', async () => {
        const menu = await executeBangCommand('@', ctx);
        expect(menu.suggestions).toContain('@u｜当前账号流量');
        expect(menu.suggestions).toContain('@a｜切换账号');
        expect(menu.suggestions).toContain('@reminder｜设置/取消提示');
        expect(menu.suggestions).toContain('@reply-monitor｜回复监控开关');
        expect(menu.suggestions?.join('\n')).not.toContain('@task-ack');
        expect(menu.suggestions?.join('\n')).not.toContain('@task-dismiss');

        const legacyMenu = await executeBangCommand('@@', ctx);
        expect(legacyMenu.suggestions).toContain('@reply-monitor｜回复监控开关');

        const consoleMenu = await executeBangCommand('@', { ...ctx, isConsoleSession: true });
        expect(consoleMenu.suggestions?.join('\n')).not.toContain('@reminder');
        expect(consoleMenu.suggestions?.join('\n')).not.toContain('@reply-monitor');
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

    it('does not include explanatory warning text', () => {
        const messages = buildConsoleWelcome().message as string[];
        const joined = messages.join('\n');
        expect(joined).not.toContain('普通消息');
    });

    it('includes commands available in console (not sessionOnly)', () => {
        const joined = buildConsoleWelcome().suggestions!.join('\n');
        // These are consoleOnly or shared commands
        expect(joined).toContain('@aa｜🔑切换Claude账号');
        expect(joined).toContain('@u｜⏱️查看Claude 用量');
        expect(joined).toContain('@aa-codex｜🔑切换codex账号');
        expect(joined).toContain('@u-codex｜⏱️查看codex用量');
        expect(joined).toContain('❇️ @ 主菜单');
        expect(joined).not.toContain('!usage (!u)');
        expect(joined).not.toContain('@l (!login)');
        // sessionOnly commands should NOT appear
        expect(joined).not.toMatch(/!restart(?!-all)/);
        // !auth is sessionOnly — must NOT appear in console welcome
        expect(joined).not.toMatch(/^!auth\b(?!-all)/m);
    });

    it('lists login/usage/auth-all in registry order with codex variants interleaved', () => {
        const messages = buildConsoleWelcome().suggestions!;
        const indices = {
            usage: messages.findIndex(m => optionLabel(m).startsWith('@u｜')),
            usageCodex: messages.findIndex(m => optionLabel(m).startsWith('@u-codex｜')),
            authAll: messages.findIndex(m => optionLabel(m).startsWith('@aa｜')),
            authAllCodex: messages.findIndex(m => optionLabel(m).startsWith('@aa-codex｜')),
            mainMenu: messages.findIndex(m => optionLabel(m).startsWith('❇️ @')),
        };
        for (const [k, v] of Object.entries(indices)) {
            expect(v, `${k} not found`).toBeGreaterThanOrEqual(0);
        }
        expect(indices.usage).toBeLessThan(indices.usageCodex);
        expect(indices.usageCodex).toBeLessThan(indices.authAll);
        expect(indices.authAll).toBeLessThan(indices.authAllCodex);
        expect(indices.authAllCodex).toBeLessThan(indices.mainMenu);
    });

    it('shows auth-all in the welcome listing (not hidden)', () => {
        const joined = buildConsoleWelcome().suggestions!.join('\n');
        expect(joined).toContain('@aa｜🔑切换Claude账号');
        expect(joined).toContain('@aa-codex｜🔑切换codex账号');
    });

    it('suggestions list console-available commands', () => {
        const suggestions = buildConsoleWelcome().suggestions!;
        expect(suggestions).toContain('@aa｜🔑切换Claude账号');
        expect(suggestions).toContain('@aa-codex｜🔑切换codex账号');
        expect(suggestions).not.toContain('@l');
        expect(suggestions).not.toContain('@l-codex');
        expect(suggestions).toContain('@u｜⏱️查看Claude 用量');
        expect(suggestions).toContain('@u-codex｜⏱️查看codex用量');
        expect(suggestions).toContain('❇️ @ 主菜单');
        // !auth is sessionOnly — should NOT be in console suggestions
        expect(suggestions).not.toContain('!auth');
    });

    it('does not include hidden commands', () => {
        const messages = buildConsoleWelcome().message as string[];
        const joined = messages.join('\n');
        expect(joined).not.toContain('!test');
    });

    it('does not end with non-bang message warning', () => {
        const messages = buildConsoleWelcome().message as string[];
        expect(messages[messages.length - 1]).not.toContain('普通消息');
    });

    it('includes suggestion buttons for console commands', () => {
        const result = buildConsoleWelcome();
        expect(result.suggestions).toBeDefined();
        expect(result.suggestions!.length).toBeGreaterThan(0);
        expect(result.suggestions!.every(s => typeof s === 'string' && (s.startsWith('@') || s.startsWith('!') || s.startsWith('❇️')))).toBe(true);
        expect(result.suggestions).toContain('❇️ @ 主菜单');
    });
});

describe('SEPARATOR', () => {
    it('is a non-empty string of box-drawing characters', () => {
        expect(typeof SEPARATOR).toBe('string');
        expect(SEPARATOR.length).toBeGreaterThan(0);
    });
});
