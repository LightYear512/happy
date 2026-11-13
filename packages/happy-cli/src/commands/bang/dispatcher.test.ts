import { describe, it, expect } from 'vitest';
import { isBangCommand, buildConsoleWelcome, executeBangCommand, consoleCommandText, createConsoleMenu, SEPARATOR } from './dispatcher';
import { renderOptionSuggestion, type BangOptionSuggestion } from './types';
import { buildTaskMessageActionSuggestions } from './taskMessageCommand';

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
        expect(isBangCommand('@task')).toBe(true);
        expect(isBangCommand('@task-ack m12-1｜1 已处理，确认')).toBe(true);
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
        expect(isBangCommand('@')).toBe(false);
        expect(isBangCommand('@@')).toBe(true);
        expect(isBangCommand('❇️ @@ 主菜单')).toBe(true);
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
        expect(help.suggestions).toContain('@a｜切换 CCS 账号');

        expect(isBangCommand('@u-codex')).toBe(true);
        expect(isBangCommand('@aa-codex')).toBe(true);

        const oldShortAlias = await executeBangCommand('!h', ctx);
        expect((oldShortAlias.message as string[]).join('\n')).toContain('未知命令 "!h"');
    });

    it('shows htask toggles in the @@ quick menu while leaving lone @ as model input', async () => {
        const menu = await executeBangCommand('@@', ctx);
        expect(menu.suggestions).toContain('@u｜当前账号流量');
        expect(menu.suggestions).toContain('@a｜切换账号');
        expect(menu.suggestions).toContain('@reminder｜设置/取消提示');
        expect(menu.suggestions).toContain('@reply-monitor｜回复监控开关');
        expect(menu.suggestions?.join('\n')).not.toContain('@task-ack');
        expect(menu.suggestions?.join('\n')).not.toContain('@task-dismiss');
        expect(menu.suggestions?.join('\n')).not.toContain('@task｜');

        const consoleMenu = await executeBangCommand('@@', { ...ctx, isConsoleSession: true });
        expect(consoleMenu.suggestions).toContainEqual({ label: '其他功能', value: '!help' });
        expect(consoleMenu.suggestions?.join('\n')).not.toContain('@reminder');
        expect(consoleMenu.suggestions?.join('\n')).not.toContain('@reply-monitor');
    });
});

describe('index maintenance entry', () => {
    const ctx = { client: {} as never, session: null, messageQueue: {} as never, currentEnhancedMode: {} as never };
    it('blocks maintenance in a model conversation', async () => {
        const result = await executeBangCommand('!index', ctx);
        expect(result.message).toContain('仅在控制台');
    });
    it('rejects unregistered names and paths before doing work', async () => {
        const result = await executeBangCommand('!index ../../not-an-account', { ...ctx, isConsoleSession: true });
        expect(result.message).toContain('未找到已登录');
        expect(result.suggestions).toContain('!index');
    });
});

describe('@task action suggestions', () => {
    it('uses hidden durable values instead of visible volatile refs', () => {
        const suggestions = buildTaskMessageActionSuggestions([
            { message_id: 'TM-2026-06-13T152633-813599Z-ef493ff1c5' },
        ]);

        expect(suggestions).toEqual([
            { label: '1 已处理，确认', value: '@task-ack TM-2026-06-13T152633-813599Z-ef493ff1c5' },
            { label: '1 重复/不处理，忽略', value: '@task-dismiss TM-2026-06-13T152633-813599Z-ef493ff1c5' },
        ]);
        expect(renderOptionSuggestion(suggestions[0])).toBe(
            '<option value="@task-ack TM-2026-06-13T152633-813599Z-ef493ff1c5">1 已处理，确认</option>',
        );
        expect(renderOptionSuggestion(suggestions[0])).not.toContain('m1-1');
    });
});

describe('buildConsoleWelcome', () => {
    it('renders all console actions in the original mobile option format and routes visible labels', async () => {
        // Original App parser before value attributes were supported (8384cbf3).
        const parseOriginalOptions = (text: string) => text.split('\n').flatMap(line => {
            const match = line.match(/<option>(.*?)<\/option>/);
            return match ? [match[1]] : [];
        });
        const welcome = buildConsoleWelcome();
        const menu = createConsoleMenu();
        const rendered = menu.render(welcome.suggestions!);
        const labels = parseOriginalOptions(rendered);
        expect(labels).toEqual(welcome.suggestions!.map(optionLabel));
        expect(labels.map(consoleCommandText)).toEqual([
            '!create-codex gpt', '!create-codex deepseek',
            '!switch-codex gpt', '!switch-codex deepseek', '@aa --Claude', '!help',
        ]);
        const ctx = { isConsoleSession: true, flavor: 'codex' } as const;
        const tools = await executeBangCommand(consoleCommandText(labels.at(-1)!), ctx as never);
        const back = parseOriginalOptions(menu.render(tools.suggestions!)).at(-1)!;
        expect(await executeBangCommand(consoleCommandText(back), ctx as never)).toEqual(welcome);

        const dynamic = parseOriginalOptions(menu.render([
            { label: 'allall', value: '!create-codex gpt allall' },
            { label: '/project with spaces', value: '!create-codex deepseek deepseek %2Fproject%20with%20spaces' },
            { label: 'Project A', value: '!switch-codex gpt session-a' },
            { label: 'allall', value: '!switch-codex gpt session-a allall' },
            { label: 'Unavailable', value: '!switch-codex gpt unavailable', disabled: true },
        ]));
        expect(dynamic).toEqual([
            'allall', '/project with spaces', 'Project A', 'allall (2)',
        ]);
        expect(dynamic.map(text => menu.resolve(text))).toEqual([
            '!create-codex gpt allall',
            '!create-codex deepseek deepseek %2Fproject%20with%20spaces',
            '!switch-codex gpt session-a', '!switch-codex gpt session-a allall',
        ]);
        menu.clear();
        expect(menu.resolve('/project with spaces')).toBe('/project with spaces');
        expect(menu.resolve('创建codex+DeepSeek会话')).toBe('!create-codex deepseek');
        const escaped = parseOriginalOptions(menu.render([{ label: '/A & B <目录>', value: '!create-codex deepseek deepseek %2FA' }]))[0];
        expect(menu.resolve(escaped)).toBe('!create-codex deepseek deepseek %2FA');
        expect(menu.resolve('/A & B <目录>')).toBe('!create-codex deepseek deepseek %2FA');
        menu.render(welcome.suggestions!);
        expect(menu.resolve('/A & B <目录>')).toBe('/A & B <目录>');
    });

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

    it('keeps all provider account actions accessible and moves maintenance to a submenu', async () => {
        expect(buildConsoleWelcome().suggestions).toEqual([
            { label: '创建codex+GPT会话', value: '!create-codex gpt' },
            { label: '创建codex+DeepSeek会话', value: '!create-codex deepseek' },
            { label: '切换GPT账号', value: '!switch-codex gpt' },
            { label: '切换DeepSeek账号', value: '!switch-codex deepseek' },
            { label: '切换Claude账号', value: '@aa --Claude' },
            { label: '其他功能', value: '!help' },
        ]);
        const tools = await executeBangCommand('!help', { isConsoleSession: true } as never);
        expect(tools.suggestions).toContain('!index｜检查并修复 Codex 索引');
        expect(tools.suggestions).toContain('@l --Claude｜登录 Claude 账号');
        expect(tools.suggestions).toContain('@u --codex｜⏱️查看codex用量');
        expect(tools.suggestions).toContain('@l --codex｜登录 Codex 账号');
        expect(tools.suggestions).toContainEqual({ label: '❇️ @@ 主菜单', value: '@@' });
    });

    it('returns the Codex console menu for both existing labels and new button values', async () => {
        const ctx = { isConsoleSession: true, flavor: 'codex' } as const;
        for (const text of ['❇️ @@ 主菜单', '@@']) {
            expect(await executeBangCommand(text, ctx as never)).toEqual(buildConsoleWelcome());
        }
        const tools = await executeBangCommand('!help', ctx as never);
        expect(tools.suggestions).toContain('@l --codex｜登录 Codex 账号');
        expect(tools.suggestions).toContain('@u --codex｜⏱️查看codex用量');
        expect(tools.suggestions).toContain('@aa --Claude｜🔑设置Claude全局账号');
        expect(tools.suggestions).toContain('@aa --codex｜🔑设置Codex全局账号');
        expect(tools.suggestions).toContain('@l --Claude｜登录 Claude 账号');
        expect(renderOptionSuggestion(tools.suggestions!.at(-1)!)).toBe(
            '<option value="@@">❇️ @@ 主菜单</option>',
        );
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
        expect(result.suggestions!.every(s => typeof s === 'string'
            ? s.startsWith('@') || s.startsWith('!') || s.startsWith('❇️')
            : isBangCommand(s.value ?? s.label))).toBe(true);
        expect(result.suggestions).toEqual(expect.arrayContaining([
            { label: '创建codex+GPT会话', value: '!create-codex gpt' },
            { label: '创建codex+DeepSeek会话', value: '!create-codex deepseek' },
        ]));
        expect(result.suggestions).toContainEqual({ label: '其他功能', value: '!help' });
    });
});

describe('SEPARATOR', () => {
    it('is a non-empty string of box-drawing characters', () => {
        expect(typeof SEPARATOR).toBe('string');
        expect(SEPARATOR.length).toBeGreaterThan(0);
    });
});
