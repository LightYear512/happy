import { logger } from '@/ui/logger';
import { handleAuthBangCommand, handleAuthAllBangCommand } from './authCommand';
import { handleLoginBangCommand } from './loginCommand';
import { handleRestartBangCommand, handleRestartAllBangCommand } from './restartCommand';
import { handleUsageBangCommand } from './usageCommand';
import { SEPARATOR, type BangCommandContext, type BangCommandHandler, type BangCommandResult } from './types';

export { SEPARATOR };
export { hasActiveInteractiveSession, handleInteractiveInput } from './interactiveSession';
export { buildConsoleWelcome, buildSessionWelcome };

/**
 * Registry of bang commands with descriptions for !help.
 * sessionOnly: only available in normal agent sessions (not console)
 * consoleOnly: only available in console sessions (not normal agent sessions)
 */
const commands: Record<string, { handler: BangCommandHandler; desc: string; loadingMsg?: string; sessionOnly?: boolean; consoleOnly?: boolean; hidden?: boolean }> = {
    'auth':        { handler: handleAuthBangCommand,        desc: '切换 CCS 账号' },
    'auth-all':    { handler: handleAuthAllBangCommand,     desc: '切换全部会话账号', consoleOnly: true },
    'usage':       { handler: handleUsageBangCommand,       desc: '查看 API 用量', loadingMsg: '⏳ 正在查询用量...' },
    'login':       { handler: handleLoginBangCommand,       desc: '登录账户' },
    'restart':     { handler: handleRestartBangCommand,     desc: '重启会话', sessionOnly: true },
    'restart-all': { handler: handleRestartAllBangCommand,  desc: '重启全部会话', consoleOnly: true, hidden: true },
};

/** Short aliases for convenience on mobile keyboards. */
const aliases: Record<string, string> = {
    a: 'auth',
    aa: 'auth-all',
    u: 'usage',
    l: 'login',
    r: 'restart',
    ra: 'restart-all',
    h: 'help',
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
 * Build the console session welcome message listing commands available in console.
 */
function buildConsoleWelcome(): BangCommandResult {
    const messages: string[] = [
        '🖥️ 控制台',
        '常驻轻量级会话，仅处理 ! 指令\n不启动 Claude，不消耗 API 额度',
        SEPARATOR,
    ];
    const suggestions: string[] = [];

    for (const [name, entry] of Object.entries(commands)) {
        if (entry.hidden || entry.sessionOnly) continue;
        const cmdAliases = Object.entries(aliases)
            .filter(([, target]) => target === name)
            .map(([alias]) => `!${alias}`);
        const aliasStr = cmdAliases.length > 0 ? ` (${cmdAliases.join(', ')})` : '';
        messages.push(`!${name}${aliasStr} → ${entry.desc}`);
        suggestions.push(`!${name}`);
    }
    messages.push(`!help (!h) → 显示全部命令`);
    suggestions.push('!help');
    messages.push(SEPARATOR);
    messages.push('普通消息不会被处理，请使用 ! 开头的命令');

    return { message: messages, action: 'none', suggestions };
}

/**
 * Build the session welcome message listing commands available to normal (non-console) sessions.
 */
function buildSessionWelcome(): BangCommandResult {
    const suggestions: string[] = [];
    for (const [name, entry] of Object.entries(commands)) {
        if (entry.hidden || entry.consoleOnly) continue;
        suggestions.push(`!${name}`);
    }
    suggestions.push('!help');
    return { message: '⚡ 会话已就绪', action: 'none', suggestions };
}

/**
 * Build the !help output listing all available commands.
 */
function buildHelp(isConsole: boolean): BangCommandResult {
    const messages: string[] = ['📖 快捷命令', SEPARATOR];
    const suggestions: string[] = [];

    for (const [name, entry] of Object.entries(commands)) {
        if (entry.hidden) continue;
        if (isConsole && entry.sessionOnly) continue;
        if (!isConsole && entry.consoleOnly) continue;

        const cmdAliases = Object.entries(aliases)
            .filter(([, target]) => target === name)
            .map(([alias]) => `!${alias}`);
        const aliasStr = cmdAliases.length > 0 ? ` (${cmdAliases.join(', ')})` : '';
        messages.push(`!${name}${aliasStr} → ${entry.desc}`);
        suggestions.push(`!${name}`);
    }

    messages.push(`!help (!h) → 显示帮助`);
    suggestions.push('!help');
    messages.push(SEPARATOR);

    return { message: messages, action: 'none', suggestions };
}

/**
 * Execute a bang command.
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
        const available = Object.keys(commands).map(c => `!${c}`).join(', ');
        return {
            message: [`❌ 未知命令 "!${name}"`, `可用命令: ${available}`],
            action: 'none',
            suggestions: ['!help'],
        };
    }

    // Block session-only commands in console
    if (ctx.isConsoleSession && entry.sessionOnly) {
        return { message: `ℹ️ !${name} 仅在会话中可用`, action: 'none' };
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
            message: `❌ !${name} 失败: ${error instanceof Error ? error.message : '未知错误'}`,
            action: 'none',
        };
    }
}
