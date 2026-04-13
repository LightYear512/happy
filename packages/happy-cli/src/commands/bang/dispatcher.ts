import { logger } from '@/ui/logger';
import { handleAuthBangCommand, handleAuthAllBangCommand } from './authCommand';
import { handleLoginBangCommand } from './loginCommand';
import { handleRestartBangCommand, handleRestartAllBangCommand } from './restartCommand';
import { handleUsageBangCommand } from './usageCommand';
import { handleTestBangCommand } from './testCommand';
import { handleTitleBangCommand } from './titleCommand';
import { SEPARATOR, type BangCommandContext, type BangCommandHandler, type BangCommandResult } from './types';

export { SEPARATOR };
export { hasActiveInteractiveSession, handleInteractiveInput } from './interactiveSession';

/**
 * Registry of bang commands with descriptions for !help.
 * sessionOnly: only available in normal agent sessions (not console)
 * consoleOnly: only available in console sessions (not normal agent sessions)
 */
const commands: Record<string, { handler: BangCommandHandler; desc: string; loadingMsg?: string; sessionOnly?: boolean; consoleOnly?: boolean; hidden?: boolean; flavorOnly?: BangCommandContext['flavor'] }> = {
    'auth':        { handler: handleAuthBangCommand,        desc: '切换 CCS 账号', sessionOnly: true },
    'login':       { handler: handleLoginBangCommand,       desc: '登录账户' },
    'usage':       { handler: handleUsageBangCommand,       desc: '查看 API 用量' },
    'auth-all':    { handler: handleAuthAllBangCommand,     desc: '切换全部会话账号', consoleOnly: true },
    'restart':     { handler: handleRestartBangCommand,     desc: '重启会话', sessionOnly: true },
    'restart-all': { handler: handleRestartAllBangCommand,  desc: '重启全部会话', consoleOnly: true },
    // TODO: !session / !open 暂停使用，待 multi-backend 会话浏览重构后恢复。实现保留在 sessionCommand.ts / openCommand.ts。
    // 'session':     { handler: handleSessionsBangCommand,    desc: '浏览项目目录和会话', loadingMsg: '⏳ 正在扫描会话...', consoleOnly: true },
    // 'open':        { handler: handleOpenBangCommand,        desc: '打开会话', loadingMsg: '⏳ 正在打开会话...', consoleOnly: true },
    'test':        { handler: handleTestBangCommand,        desc: '测试命令输出', consoleOnly: true, hidden: true },
    'title':       { handler: handleTitleBangCommand,       desc: '修改会话标题', sessionOnly: true, flavorOnly: 'codex' },
};

/** Short aliases for convenience on mobile keyboards. */
const aliases: Record<string, string> = {
    a: 'auth',
    aa: 'auth-all',
    l: 'login',
    // o: 'open', // TODO: 暂停使用
    r: 'restart',
    ra: 'restart-all',
    t: 'title',
    u: 'usage',
    h: 'help',
    // s: 'session', // TODO: 暂停使用
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
/** Commands hidden from help output (low-frequency commands not worth showing). */
const helpHidden = new Set(['restart-all']);

/** Commands that support --codex flag, with their codex-specific descriptions. */
const codexVariants: Record<string, string> = {
    'auth':     '切换当前会话 Codex 账号',
    'auth-all': '切换全部会话 Codex 账号',
    'login':    '登录 Codex 账号',
    'usage':    '查看 Codex 用量',
};

function buildHelp(isConsole: boolean, flavor?: string): BangCommandResult {
    const baseCommands: Array<[string, string]> = Object.entries(commands)
        .filter(([name, entry]) => !entry.hidden && !helpHidden.has(name) && !(isConsole && entry.sessionOnly) && !(!isConsole && entry.consoleOnly) && (!entry.flavorOnly || entry.flavorOnly === flavor))
        .map(([name, { desc }]) => [name, desc] as [string, string]);

    const messages: string[] = [
        '📖 快捷命令',
        SEPARATOR,
    ];

    const suggestions: string[] = [];

    for (const [name, desc] of baseCommands) {
        const cmdAliases = Object.entries(aliases)
            .filter(([, target]) => target === name)
            .map(([alias]) => `!${alias}`);

        const aliasStr = cmdAliases.length > 0 ? ` (${cmdAliases.join(', ')})` : '';
        messages.push(`!${name}${aliasStr} → ${desc}`);
        suggestions.push(`!${name}`);
        if (isConsole && codexVariants[name]) {
            messages.push(`!${name} --codex → ${codexVariants[name]}`);
            suggestions.push(`!${name} --codex`);
        }
    }

    messages.push(`!help (!h) → 显示帮助`);
    suggestions.push('!help');

    messages.push(SEPARATOR);

    return {
        message: messages,
        action: 'none',
        suggestions,
    };
}

/** Commands hidden from console welcome (available via !help but not shown on launch). */
const consoleWelcomeHidden = new Set(['restart-all']);

/**
 * Build the console welcome message listing key commands.
 * Derived from the commands registry to stay in sync with !help.
 */
export function buildConsoleWelcome(): BangCommandResult {
    const messages: string[] = [
        '🖥️ 控制台',
        '常驻轻量级会话，仅处理 ! 指令\n不启动 Claude，不消耗 API 额度',
        SEPARATOR,
    ];

    // Show commands available in console (consoleOnly + shared, exclude hidden and welcome-hidden)
    const consoleCommands = Object.entries(commands)
        .filter(([name, entry]) => !entry.hidden && !entry.sessionOnly && !consoleWelcomeHidden.has(name));

    const suggestions: string[] = [];
    for (const [name, { desc }] of consoleCommands) {
        const cmdAliases = Object.entries(aliases)
            .filter(([, target]) => target === name)
            .map(([alias]) => `!${alias}`);
        const aliasStr = cmdAliases.length > 0 ? ` (${cmdAliases.join(', ')})` : '';
        messages.push(`!${name}${aliasStr} → ${desc}`);
        suggestions.push(`!${name}`);
        if (codexVariants[name]) {
            messages.push(`!${name} --codex → ${codexVariants[name]}`);
            suggestions.push(`!${name} --codex`);
        }
    }
    messages.push(`!help (!h) → 显示全部命令`);
    suggestions.push('!help');

    messages.push(SEPARATOR);
    messages.push('普通消息不会被处理，请使用 ! 开头的命令');

    return {
        message: messages,
        action: 'none',
        suggestions,
    };
}

/**
 * Build the session welcome message listing commands available in normal sessions.
 * Derived from the commands registry to stay in sync with !help.
 */
export function buildSessionWelcome(flavor?: string): BangCommandResult {
    const messages: string[] = [
        '💡 可用快捷命令',
        SEPARATOR,
    ];

    const sessionCommands = Object.entries(commands)
        .filter(([, entry]) => !entry.hidden && !entry.consoleOnly && (!entry.flavorOnly || entry.flavorOnly === flavor));
    for (const [name, { desc }] of sessionCommands) {
        const cmdAliases = Object.entries(aliases)
            .filter(([, target]) => target === name)
            .map(([alias]) => `!${alias}`);
        const aliasStr = cmdAliases.length > 0 ? ` (${cmdAliases.join(', ')})` : '';
        messages.push(`!${name}${aliasStr} → ${desc}`);
    }
    messages.push(`!help (!h) → 显示帮助`);

    messages.push(SEPARATOR);

    return {
        message: messages,
        action: 'none',
        suggestions: [...sessionCommands.map(([name]) => `!${name}`), '!help'],
    };
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
        return buildHelp(!!ctx.isConsoleSession, ctx.flavor);
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

    // Block flavor-restricted commands in wrong backend
    if (entry.flavorOnly && entry.flavorOnly !== ctx.flavor) {
        return { message: `ℹ️ !${name} 仅在 ${entry.flavorOnly} 会话中可用`, action: 'none' };
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
