import { logger } from '@/ui/logger';
import { handleAuthBangCommand } from './authCommand';
import { handleAuthCreateBangCommand } from './loginCommand';
import { handleRestartBangCommand } from './restartCommand';
import { handleUsageBangCommand } from './usageCommand';
import { handleSessionsBangCommand } from './sessionCommand';
import { handleResumeBangCommand } from './resumeCommand';
import { handleTestBangCommand } from './testCommand';
import { SEPARATOR, type BangCommandContext, type BangCommandHandler, type BangCommandResult } from './types';

export { SEPARATOR };
export { hasActiveInteractiveSession, handleInteractiveInput } from './interactiveSession';

/**
 * Registry of bang commands with descriptions for !help.
 * sessionOnly: only available in normal Claude sessions (not console)
 * consoleOnly: only available in console sessions (not normal Claude sessions)
 */
const commands: Record<string, { handler: BangCommandHandler; desc: string; loadingMsg?: string; sessionOnly?: boolean; consoleOnly?: boolean; hidden?: boolean }> = {
    auth:     { handler: handleAuthBangCommand,     desc: '切换 CCS 账号', sessionOnly: true },
    login:    { handler: handleAuthCreateBangCommand, desc: '登录新账号/重新登录旧账号', consoleOnly: true },
    restart:  { handler: handleRestartBangCommand,  desc: '重启会话', sessionOnly: true },
    usage:    { handler: handleUsageBangCommand,    desc: '查看 API 用量' },
    session:  { handler: handleSessionsBangCommand, desc: '查看可恢复会话', loadingMsg: '⏳ 正在扫描会话...', consoleOnly: true },
    resume:   { handler: handleResumeBangCommand,   desc: '恢复指定会话', loadingMsg: '⏳ 正在恢复会话...', consoleOnly: true },
    test:     { handler: handleTestBangCommand,     desc: '测试命令输出', consoleOnly: true, hidden: true },
};

/** Short aliases for convenience on mobile keyboards. */
const aliases: Record<string, string> = {
    a: 'auth',
    l: 'login',
    r: 'resume',
    re: 'restart',
    u: 'usage',
    h: 'help',
    s: 'session',
};

/**
 * Check if a message is a bang command (starts with `!`).
 */
export function isBangCommand(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.startsWith('!') && trimmed.length > 1 && trimmed[1] !== ' ';
}

/**
 * Parse a bang command into its name and arguments.
 */
function parseBangCommand(text: string): { name: string; args: string } {
    const trimmed = text.trim();
    // Remove leading `!`
    const body = trimmed.slice(1);
    const spaceIndex = body.indexOf(' ');

    if (spaceIndex === -1) {
        return { name: body.toLowerCase(), args: '' };
    }

    return {
        name: body.slice(0, spaceIndex).toLowerCase(),
        args: body.slice(spaceIndex + 1),
    };
}

/**
 * Build the !help output listing all available commands.
 */
function buildHelp(isConsole: boolean): BangCommandResult {
    const allCommands: Array<[string, string]> = [
        ...Object.entries(commands)
            .filter(([, entry]) => !entry.hidden && !(isConsole && entry.sessionOnly) && !(!isConsole && entry.consoleOnly))
            .map(([name, { desc }]) => [name, desc] as [string, string]),
        ['help', '显示帮助'],
    ];

    const messages: string[] = [
        '📖 快捷命令',
        SEPARATOR,
    ];

    for (const [name, desc] of allCommands) {
        const cmdAliases = Object.entries(aliases)
            .filter(([, target]) => target === name)
            .map(([alias]) => `!${alias}`);

        const aliasStr = cmdAliases.length > 0 ? ` (${cmdAliases.join(', ')})` : '';
        messages.push(`!${name}${aliasStr} → ${desc}`);
    }

    messages.push(SEPARATOR);

    return {
        message: messages,
        action: 'none',
        suggestions: allCommands.filter(([name]) => name !== 'help').map(([name]) => `!${name}`),
    };
}

/**
 * Build the console welcome message listing key commands.
 * Derived from the commands registry to stay in sync with !help.
 */
export function buildConsoleWelcome(): string[] {
    const messages: string[] = [
        '🖥️ 控制台',
        '常驻轻量级会话，仅处理 ! 指令\n不启动 Claude，不消耗 API 额度',
        SEPARATOR,
    ];

    // Show commands available in console (consoleOnly + shared, exclude hidden)
    const consoleCommands = Object.entries(commands)
        .filter(([, entry]) => !entry.hidden && !entry.sessionOnly);
    for (const [name, { desc }] of consoleCommands) {
        const cmdAliases = Object.entries(aliases)
            .filter(([, target]) => target === name)
            .map(([alias]) => `!${alias}`);
        const aliasStr = cmdAliases.length > 0 ? ` (${cmdAliases.join(', ')})` : '';
        messages.push(`!${name}${aliasStr} → ${desc}`);
    }

    messages.push(SEPARATOR);
    messages.push('普通消息不会被处理，请使用 ! 开头的命令');
    return messages;
}

/**
 * Execute a bang command. Returns null if the command is not recognized.
 */
export async function executeBangCommand(text: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    let { name, args } = parseBangCommand(text);
    logger.debug(`[bang] Executing command: !${name} args="${args}"`);

    // Resolve alias
    if (aliases[name]) {
        name = aliases[name];
    }

    // Built-in help command
    if (name === 'help') {
        return buildHelp(!!ctx.isConsoleSession);
    }

    // !cancel without an active interactive session
    if (name === 'cancel' || name === '取消') {
        return { message: 'ℹ️ 当前没有进行中的操作', action: 'none' };
    }

    const entry = commands[name];

    if (!entry) {
        return {
            message: [`❌ 未知命令 "!${name}"`, '输入 !help 查看可用命令。'],
            action: 'none',
        };
    }

    // Block session-only commands in console
    if (ctx.isConsoleSession && entry.sessionOnly) {
        return { message: `ℹ️ !${name} 仅在 Claude 会话中可用`, action: 'none' };
    }

    // Block console-only commands in normal sessions
    if (!ctx.isConsoleSession && entry.consoleOnly) {
        return { message: `ℹ️ !${name} 仅在控制台中可用`, action: 'none' };
    }

    // Send loading indicator before async commands
    if (entry.loadingMsg) {
        ctx.client.sendSessionEvent({ type: 'message', message: entry.loadingMsg });
    }

    try {
        return await entry.handler(args, ctx);
    } catch (error) {
        logger.debug(`[bang] Command !${name} failed:`, error);
        return {
            message: `❌ !${name} 失败: ${error instanceof Error ? error.message : 'Unknown error'}`,
            action: 'none',
        };
    }
}
