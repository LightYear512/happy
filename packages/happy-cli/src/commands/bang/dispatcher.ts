import { logger } from '@/ui/logger';
import { handleAuthBangCommand } from './authCommand';
import { handleAuthCreateBangCommand } from './authCreateCommand';
import { handleRestartBangCommand } from './restartCommand';
import { handleUsageBangCommand } from './usageCommand';
import { centerText } from './format';
import type { BangCommandContext, BangCommandHandler, BangCommandResult } from './types';

export { hasActiveInteractiveSession, handleInteractiveInput } from './interactiveSession';

/**
 * Registry of bang commands with descriptions for !help.
 */
const commands: Record<string, { handler: BangCommandHandler; desc: string; loadingMsg?: string }> = {
    auth:    { handler: handleAuthBangCommand,    desc: '切换 CCS 账号' },
    login:   { handler: handleAuthCreateBangCommand, desc: '登录新账号' },
    restart: { handler: handleRestartBangCommand, desc: '重启会话' },
    usage:   { handler: handleUsageBangCommand,   desc: '查看 API 用量', loadingMsg: '⏳ 正在查询用量...' },
};

/** Short aliases for convenience on mobile keyboards. */
const aliases: Record<string, string> = {
    a: 'auth',
    l: 'login',
    r: 'restart',
    u: 'usage',
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
function buildHelp(): BangCommandResult {
    const lines: string[] = [
        '📖 快捷命令',
        '',
    ];

    const allCommands: Array<[string, string]> = [
        ...Object.entries(commands).map(([name, { desc }]) => [name, desc] as [string, string]),
        ['help', '显示帮助'],
    ];

    for (const [name, desc] of allCommands) {
        const cmdAliases = Object.entries(aliases)
            .filter(([, target]) => target === name)
            .map(([alias]) => `!${alias}`);

        const aliasStr = cmdAliases.length > 0 ? ` (${cmdAliases.join(', ')})` : '';
        lines.push(`!${name}${aliasStr} — ${desc}`);
    }

    return { message: centerText(lines), action: 'none' };
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
        return buildHelp();
    }

    // !cancel without an active interactive session
    if (name === 'cancel' || name === '取消') {
        return { message: centerText(['ℹ️ 当前没有进行中的操作']), action: 'none' };
    }

    const entry = commands[name];

    if (!entry) {
        const lines = [
            `❌ 未知命令 "!${name}"`,
            '',
            '输入 !help 查看可用命令。',
        ];
        return { message: centerText(lines), action: 'none' };
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
