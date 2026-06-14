import { logger } from '@/ui/logger';
import { handleAuthBangCommand, handleAuthAllBangCommand } from './authCommand';
import { handleLoginBangCommand } from './loginCommand';
import { handleRestartBangCommand, handleRestartAllBangCommand } from './restartCommand';
import { getCachedProfileUsageEntry, handleUsageBangCommand, type ProfileUsageEntry } from './usageCommand';
import { handleTestBangCommand } from './testCommand';
import { handleReminderBangCommand } from './reminderCommand';
import { handleReplyMonitorBangCommand } from './replyMonitorCommand';
import { buildTaskMessageMenuSuggestions, handleTaskMessageAckBangCommand, handleTaskMessageDismissBangCommand, handleTaskMessagesBangCommand } from './taskMessageCommand';
import { SEPARATOR, type BangCommandContext, type BangCommandHandler, type BangCommandResult, type BangOptionSuggestion } from './types';
import { getCurrentProfileForFlavor, readCcsProfiles, readCodexDefaultProfile, type AuthFlavor } from './ccsProfiles';

export { SEPARATOR };
export { hasActiveInteractiveSession, handleInteractiveInput } from './interactiveSession';

/**
 * Registry of bang commands with descriptions for !help.
 * sessionOnly: only available in normal agent sessions (not console)
 * consoleOnly: only available in console sessions (not normal agent sessions)
 */
const commands: Record<string, { handler: BangCommandHandler; desc: string; loadingMsg?: string; sessionOnly?: boolean; consoleOnly?: boolean; hidden?: boolean }> = {
    'auth':        { handler: handleAuthBangCommand,        desc: '切换 CCS 账号', sessionOnly: true },
    'login':       { handler: handleLoginBangCommand,       desc: '登录账户' },
    'usage':       { handler: handleUsageBangCommand,       desc: '⏱️查看Claude 用量' },
    'auth-all':    { handler: handleAuthAllBangCommand,     desc: '🔑切换Claude账号', consoleOnly: true },
    'restart':     { handler: handleRestartBangCommand,     desc: '重启会话', sessionOnly: true },
    'restart-all': { handler: handleRestartAllBangCommand,  desc: '重启全部会话', consoleOnly: true },
    'reminder':    { handler: handleReminderBangCommand,    desc: '设置/取消提示', sessionOnly: true, hidden: true },
    'reply-monitor': { handler: handleReplyMonitorBangCommand, desc: '回复监控开关', sessionOnly: true, hidden: true },
    'task': { handler: handleTaskMessagesBangCommand, desc: '任务消息', sessionOnly: true, hidden: true },
    'task-ack': { handler: handleTaskMessageAckBangCommand, desc: '确认任务消息', sessionOnly: true, hidden: true },
    'task-dismiss': { handler: handleTaskMessageDismissBangCommand, desc: '忽略任务消息', sessionOnly: true, hidden: true },
    // TODO: !session / !open 暂停使用，待 multi-backend 会话浏览重构后恢复。实现保留在 sessionCommand.ts / openCommand.ts。
    // 'session':     { handler: handleSessionsBangCommand,    desc: '浏览项目目录和会话', loadingMsg: '⏳ 正在扫描会话...', consoleOnly: true },
    // 'open':        { handler: handleOpenBangCommand,        desc: '打开会话', loadingMsg: '⏳ 正在打开会话...', consoleOnly: true },
    'test':        { handler: handleTestBangCommand,        desc: '测试命令输出', consoleOnly: true, hidden: true },
};

/** Short aliases for convenience on mobile keyboards. */
const aliases: Record<string, string> = {
    a: 'auth',
    aa: 'auth-all',
    'aa-codex': 'auth-all',
    l: 'login',
    'l-codex': 'login',
    // o: 'open', // TODO: 暂停使用
    r: 'restart',
    ra: 'restart-all',
    u: 'usage',
    'u-codex': 'usage',
    reminder: 'reminder',
    'reply-monitor': 'reply-monitor',
    task: 'task',
    'task-ack': 'task-ack',
    'task-dismiss': 'task-dismiss',
    h: 'help',
    // s: 'session', // TODO: 暂停使用
};

const aliasArgs: Record<string, string> = {
    'aa-codex': '--codex',
    'l-codex': '--codex',
    'u-codex': '--codex',
};

const COMMAND_PREFIX = '!';
const ALIAS_PREFIX = '@';

function formatCommand(name: string): string {
    return `${COMMAND_PREFIX}${name}`;
}

function formatAlias(alias: string): string {
    return `${ALIAS_PREFIX}${alias}`;
}

function formatPrimaryInvocation(name: string): string {
    const alias = Object.entries(aliases).find(([, target]) => target === name)?.[0];
    return alias ? formatAlias(alias) : formatCommand(name);
}

function formatPrimaryInvocationWithArgs(name: string, args: string): string {
    const alias = Object.entries(aliases).find(([aliasName, target]) => target === name && aliasArgs[aliasName] === args)?.[0];
    if (alias) return formatAlias(alias);
    return `${formatPrimaryInvocation(name)} ${args}`.trim();
}

function formatCommandDisplay(name: string): string {
    const primary = formatPrimaryInvocation(name);
    const full = formatCommand(name);
    return primary === full ? full : `${primary} (${full})`;
}

function formatCommandDisplayWithArgs(name: string, args: string): string {
    const primary = formatPrimaryInvocationWithArgs(name, args);
    const full = `${formatCommand(name)} ${args}`.trim();
    return primary === full ? full : `${primary} (${full})`;
}

function compactOption(commandText: string, desc: string): string {
    return `${commandText}｜${desc}`;
}

const MAIN_MENU_OPTION = '❇️ @ 主菜单';
const CACHE_AGE_DISPLAY_MIN_MS = 5 * 60 * 1000;

function formatCompactResetTime(resetsAt: string | null): string | null {
    if (!resetsAt) return null;
    const resetDate = new Date(resetsAt);
    const diffMs = resetDate.getTime() - Date.now();
    if (!Number.isFinite(diffMs)) return null;
    const totalMin = Math.max(0, Math.ceil(diffMs / 60000));
    const hours = Math.floor(totalMin / 60);
    const minutes = totalMin % 60;
    return `下${hours}:${minutes.toString().padStart(2, '0')}时`;
}

function formatCompactSevenDayResetTime(resetsAt: string | null): string | null {
    if (!resetsAt) return null;
    const resetDate = new Date(resetsAt);
    const diffMs = resetDate.getTime() - Date.now();
    if (!Number.isFinite(diffMs)) return null;
    const totalHours = Math.max(0, Math.floor(diffMs / 3600000));
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return `${days}D:${hours}h`;
}

function formatCompactCacheAge(cachedAt: number): string {
    const ageMin = Math.max(0, Math.floor((Date.now() - cachedAt) / 60000));
    if (ageMin < 60) return `${ageMin}m`;
    const ageHours = Math.floor(ageMin / 60);
    if (ageHours < 24) return `${ageHours}h`;
    return `${Math.floor(ageHours / 24)}d`;
}

function formatCompactDataAge(entry: ProfileUsageEntry): string | null {
    if (!entry.cachedAt) return null;
    if (Date.now() - entry.cachedAt < CACHE_AGE_DISPLAY_MIN_MS) return null;
    return `${entry.stale ? '缓' : '取'}${formatCompactCacheAge(entry.cachedAt)}`;
}

function formatCurrentUsage(entry: ProfileUsageEntry | null): string[] {
    if (!entry) return ['用量未知'];
    const parts: string[] = [];
    if (entry.fiveHourPercent != null) {
        parts.push(`5h:${entry.fiveHourPercent.toFixed(0)}%`);
        if (entry.full) {
            const resetText = formatCompactResetTime(entry.fiveHourResetAt);
            if (resetText) parts.push(resetText);
        }
    }
    if (entry.sevenDayPercent != null) {
        parts.push(`7d:${entry.sevenDayPercent.toFixed(0)}%`);
        const resetText = formatCompactSevenDayResetTime(entry.sevenDayResetAt);
        if (resetText) parts.push(resetText);
    }
    if (parts.length === 0 && entry.summary) parts.push(entry.summary);
    const dataAge = formatCompactDataAge(entry);
    if (dataAge) parts.push(dataAge);
    return parts.length > 0 ? parts : ['用量未知'];
}

async function buildQuickSessionMenu(ctx: BangCommandContext): Promise<BangCommandResult> {
    const flavor: AuthFlavor = ctx.flavor === 'codex' ? 'codex' : 'claude';
    const defaultProfile = flavor === 'codex' ? readCodexDefaultProfile() : readCcsProfiles().defaultProfile;
    const currentProfile = getCurrentProfileForFlavor(flavor) ?? defaultProfile;
    const usage = currentProfile ? getCachedProfileUsageEntry(currentProfile, flavor) : null;
    const taskMessageSuggestions = await buildTaskMessageMenuSuggestions(ctx);
    const parts = [
        `当前账号：${currentProfile ?? '未知'}`,
        flavor === 'codex' ? 'Codex' : 'Claude',
    ];
    if (currentProfile && currentProfile === defaultProfile) parts.push('默认');
    parts.push(...formatCurrentUsage(usage));
    return {
        message: parts.join('｜'),
        action: 'none',
        suggestions: [
            ...taskMessageSuggestions,
            compactOption('@u', '当前账号流量'),
            compactOption('@a', '切换账号'),
            compactOption('@reminder', '设置/取消提示'),
            compactOption('@reply-monitor', '回复监控开关'),
        ],
    };
}

function stripLeadingCommandDecorations(text: string): string {
    return text
        .replace(/^(?:(?:[🟢💚💔🔵🚫🟣❇️]|[0-5]️⃣)\s*)+/u, '')
        .replace(/^(?:[A-Z]|\d+)[\s.、:：)）-]+(?=[!@])/iu, '')
        .replace(/^[•·▪︎-]+\s*(?=[!@])/u, '')
        .trim();
}

function stripOptionSuffix(text: string): string {
    const stripped = stripLeadingCommandDecorations(text.trim().split(/[｜|]/, 1)[0].trim());
    if (stripped === '@' || stripped === '@ 主菜单') return '@';
    if (stripped === '@@' || stripped.startsWith('@@ ')) return '@@';
    return stripped;
}

function optionCommandText(option: BangOptionSuggestion): string {
    return typeof option === 'string' ? option : option.value ?? option.label;
}

function withMainMenuOption(result: BangCommandResult): BangCommandResult {
    if (!result.suggestions?.length) return result;
    const suggestions = result.suggestions.filter(option => {
        const command = stripOptionSuffix(optionCommandText(option));
        return command !== '@' && command !== '@@';
    });
    return {
        ...result,
        suggestions: [...suggestions, MAIN_MENU_OPTION],
    };
}

/**
 * Check if a message is a command (`!full-command`) or short alias (`@alias`).
 */
export function isBangCommand(text: string): boolean {
    const trimmed = stripOptionSuffix(text);
    if (trimmed === '@' || trimmed === '@@') return true;
    if (trimmed.length <= 1 || trimmed[1] === ' ') return false;
    if (trimmed.startsWith(COMMAND_PREFIX)) return true;
    if (!trimmed.startsWith(ALIAS_PREFIX)) return false;

    const spaceIndex = trimmed.indexOf(' ');
    const alias = trimmed.slice(1, spaceIndex === -1 ? undefined : spaceIndex).toLowerCase();
    return aliases[alias] !== undefined;
}

/**
 * Parse a bang command into its name and arguments.
 */
function parseBangCommand(text: string): { prefix: string; name: string; args: string } {
    const trimmed = stripOptionSuffix(text);
    if (trimmed === '@' || trimmed === '@@') {
        return { prefix: ALIAS_PREFIX, name: '@', args: '' };
    }
    const prefix = trimmed[0] ?? COMMAND_PREFIX;
    const body = trimmed.slice(1);
    const spaceIndex = body.indexOf(' ');

    if (spaceIndex === -1) {
        return { prefix, name: body.toLowerCase(), args: '' };
    }

    return {
        prefix,
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
    'auth-all': '🔑切换codex账号',
    'login':    '登录 Codex 账号',
    'usage':    '⏱️查看codex用量',
};

function buildHelp(isConsole: boolean): BangCommandResult {
    const baseCommands: Array<[string, string]> = Object.entries(commands)
        .filter(([name, entry]) => !entry.hidden && !helpHidden.has(name) && !(isConsole && entry.sessionOnly) && !(!isConsole && entry.consoleOnly))
        .map(([name, { desc }]) => [name, desc] as [string, string]);

    const suggestions: string[] = [];

    for (const [name, desc] of baseCommands) {
        suggestions.push(compactOption(formatPrimaryInvocation(name), desc));
        if (isConsole && codexVariants[name]) {
            suggestions.push(compactOption(formatPrimaryInvocationWithArgs(name, '--codex'), codexVariants[name]));
        }
    }

    return {
        message: [],
        action: 'none',
        suggestions,
    };
}

/** Commands hidden from console welcome (available via !help but not shown on launch). */
const consoleWelcomeHidden = new Set(['restart-all', 'login']);

/**
 * Build the console welcome message listing key commands.
 * Derived from the commands registry to stay in sync with !help.
 */
export function buildConsoleWelcome(): BangCommandResult {
    const messages: string[] = [
        '🖥️ 控制台',
    ];

    // Show commands available in console (consoleOnly + shared, exclude hidden and welcome-hidden)
    const consoleCommands = Object.entries(commands)
        .filter(([name, entry]) => !entry.hidden && !entry.sessionOnly && !consoleWelcomeHidden.has(name));

    const suggestions: string[] = [];
    for (const [name, { desc }] of consoleCommands) {
        suggestions.push(compactOption(formatPrimaryInvocation(name), desc));
        if (codexVariants[name]) {
            suggestions.push(compactOption(formatPrimaryInvocationWithArgs(name, '--codex'), codexVariants[name]));
        }
    }
    return {
        message: messages,
        action: 'none',
        suggestions: [...suggestions, MAIN_MENU_OPTION],
    };
}

/**
 * Build the session welcome message listing commands available in normal sessions.
 * Derived from the commands registry to stay in sync with !help.
 */
export function buildSessionWelcome(): BangCommandResult {
    const messages: string[] = [
        '💡 可用快捷命令',
        SEPARATOR,
    ];

    const sessionCommands = Object.entries(commands)
        .filter(([, entry]) => !entry.hidden && !entry.consoleOnly);
    for (const [name, { desc }] of sessionCommands) {
        const cmdAliases = Object.entries(aliases)
            .filter(([, target]) => target === name)
            .map(([alias]) => formatAlias(alias));
        const aliasStr = cmdAliases.length > 0 ? ` (${cmdAliases.join(', ')})` : '';
        messages.push(`${formatCommandDisplay(name)}${aliasStr && formatPrimaryInvocation(name) === formatCommand(name) ? aliasStr : ''} → ${desc}`);
    }
    messages.push(SEPARATOR);

    return {
        message: messages,
        action: 'none',
        suggestions: sessionCommands.map(([name]) => formatPrimaryInvocation(name)),
    };
}

/**
 * Execute a bang command. Returns null if the command is not recognized.
 */
export async function executeBangCommand(text: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    let { prefix, name, args } = parseBangCommand(text);
    const originalCommand = `${prefix}${name}`;
    logger.debug(`[bang] Executing command: ${originalCommand} args="${args}"`);

    // Short aliases moved from !a/!h/!u to @a/@h/@u.
    if (prefix === ALIAS_PREFIX) {
        if (name === '@') {
            return ctx.isConsoleSession ? buildConsoleWelcome() : await buildQuickSessionMenu(ctx);
        }
        if (!aliases[name]) {
            return withMainMenuOption({
                message: [`❌ 未知命令 "${originalCommand}"`, `输入 ${formatCommand('help')} 或 ${formatAlias('h')} 查看可用命令。`],
                action: 'none',
                suggestions: [formatCommand('help'), formatAlias('h')],
            });
        }
        if (aliasArgs[name]) {
            args = `${aliasArgs[name]} ${args}`.trim();
        }
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
        return withMainMenuOption({
            message: [`❌ 未知命令 "${originalCommand}"`, `输入 ${formatCommand('help')} 或 ${formatAlias('h')} 查看可用命令。`],
            action: 'none',
            suggestions: [formatCommand('help'), formatAlias('h')],
        });
    }

    // Block session-only commands in console
    if (ctx.isConsoleSession && entry.sessionOnly) {
        return { message: `ℹ️ ${originalCommand} 仅在会话中可用`, action: 'none' };
    }

    // Block console-only commands in normal sessions
    if (!ctx.isConsoleSession && entry.consoleOnly) {
        return { message: `ℹ️ ${originalCommand} 仅在控制台中可用`, action: 'none' };
    }

    // Send loading indicator before async commands
    if (entry.loadingMsg) {
        ctx.client.sendSessionEvent({ type: 'message', message: entry.loadingMsg });
    }

    try {
        return withMainMenuOption(await entry.handler(args, ctx));
    } catch (error) {
        logger.debug(`[bang] Command ${originalCommand} failed:`, error);
        return {
            message: `❌ ${originalCommand} 失败: ${error instanceof Error ? error.message : '未知错误'}`,
            action: 'none',
        };
    }
}
