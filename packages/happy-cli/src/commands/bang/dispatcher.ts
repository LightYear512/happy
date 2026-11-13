import { logger } from '@/ui/logger';
import { handleAuthBangCommand, handleAuthAllBangCommand } from './authCommand';
import { handleLoginBangCommand } from './loginCommand';
import { handleIndexBangCommand } from './indexCommand';
import { CODEX_CREATE_OPTIONS, handleCreateCodexCommand } from './createCodexCommand';
import { CODEX_SWITCH_OPTIONS, handleSwitchCodexCommand } from './switchCodexCommand';
import { handleRestartBangCommand } from './restartCommand';
import { getCachedProfileUsageEntry, handleUsageBangCommand, type ProfileUsageEntry } from './usageCommand';
import { handleTestBangCommand } from './testCommand';
import { handleReminderBangCommand } from './reminderCommand';
import { handleReplyMonitorBangCommand } from './replyMonitorCommand';
import { buildTaskMessageMenuSuggestions, handleTaskMessageAckBangCommand, handleTaskMessageDismissBangCommand, handleTaskMessagesBangCommand } from './taskMessageCommand';
import { SEPARATOR, renderOptionsBlock, renderOptionSuggestion, type BangCommandContext, type BangCommandHandler, type BangCommandResult, type BangOptionSuggestion } from './types';
import { getCurrentProfileForFlavor, readCcsProfiles, readCodexDefaultProfile, type AuthFlavor } from './ccsProfiles';

export { SEPARATOR };
export { hasActiveInteractiveSession, handleInteractiveInput } from './interactiveSession';

/**
 * Registry of bang commands with descriptions for !help.
 * sessionOnly: only available in normal agent sessions (not console)
 * consoleOnly: only available in console sessions (not normal agent sessions)
 */
const commands: Record<string, { handler: BangCommandHandler; desc: string; loadingMsg?: string; sessionOnly?: boolean; consoleOnly?: boolean; hidden?: boolean }> = {
    'create-codex': { handler: handleCreateCodexCommand, desc: '创建 Codex 会话', consoleOnly: true, hidden: true },
    'switch-codex': { handler: handleSwitchCodexCommand, desc: '切换 Codex 账号', consoleOnly: true, hidden: true },
    'auth':        { handler: handleAuthBangCommand,        desc: '切换 CCS 账号', sessionOnly: true },
    'index':       { handler: handleIndexBangCommand,       desc: '检查并修复 Codex 索引', consoleOnly: true },
    'login':       { handler: handleLoginBangCommand,       desc: '登录账户' },
    'usage':       { handler: handleUsageBangCommand,       desc: '⏱️查看Claude 用量' },
    'auth-all':    { handler: handleAuthAllBangCommand,     desc: '🔑设置Claude全局账号', consoleOnly: true },
    'restart':     { handler: handleRestartBangCommand,     desc: '重启会话', sessionOnly: true },
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

const MAIN_MENU_OPTION = { label: '❇️ @@ 主菜单', value: '@@' };
const CONSOLE_MENU_OPTIONS: BangOptionSuggestion[] = [
    ...CODEX_CREATE_OPTIONS, ...CODEX_SWITCH_OPTIONS,
    { label: '切换Claude账号', value: '@aa --Claude' }, { label: '其他功能', value: '!help' },
];

/** Old mobile apps send the visible option text and cannot read value attributes. */
export function consoleCommandText(text: string): string {
    const option = [...CONSOLE_MENU_OPTIONS, MAIN_MENU_OPTION].find(option =>
        typeof option !== 'string' && option.label === text.trim());
    return option && typeof option !== 'string' ? option.value ?? option.label : text;
}

/** Old apps return the button label; only the current console menu owns that label's command. */
export function createConsoleMenu() {
    const commandsByLabel = new Map<string, string>();
    return {
        clear(): void { commandsByLabel.clear(); },
        resolve(text: string): string {
            return commandsByLabel.get(text.trim()) ?? consoleCommandText(text);
        },
        render(suggestions: BangOptionSuggestion[]): string {
            commandsByLabel.clear();
            const labels: string[] = [];
            for (const option of suggestions) {
                if (typeof option !== 'string' && option.disabled) continue;
                const originalLabel = typeof option === 'string' ? option : option.label;
                const command = typeof option === 'string' ? option : option.value ?? option.label;
                let label = originalLabel;
                for (let suffix = 2; commandsByLabel.has(label); suffix++) label = `${originalLabel} (${suffix})`;
                commandsByLabel.set(label, command);
                // The original App keeps XML entities in its clicked text; newer Apps decode them.
                const escaped = renderOptionSuggestion(label).slice('<option>'.length, -'</option>'.length);
                commandsByLabel.set(escaped, command);
                labels.push(label);
            }
            return renderOptionsBlock(labels);
        },
    };
}
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
    if (stripped === '@@' || stripped.startsWith('@@ ') || stripped === '@ 主菜单') return '@@';
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
    if (trimmed === '@@') return true;
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
    if (trimmed === '@@') {
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
const helpHidden = new Set<string>();

/** Commands that support provider flags, with their Codex-specific descriptions. */
const codexVariants: Record<string, string> = {
    'auth':     '切换当前会话 Codex 账号',
    'auth-all': '🔑设置Codex全局账号',
    'login':    '登录 Codex 账号',
    'usage':    '⏱️查看codex用量',
};

function buildHelp(isConsole: boolean): BangCommandResult {
    const baseCommands: Array<[string, string]> = Object.entries(commands)
        .filter(([name, entry]) => !entry.hidden && !helpHidden.has(name) && !(isConsole && entry.sessionOnly) && !(!isConsole && entry.consoleOnly))
        .map(([name, { desc }]) => [name, desc] as [string, string]);

    const suggestions: BangOptionSuggestion[] = [];

    for (const [name, desc] of baseCommands) {
        if (isConsole && codexVariants[name]) {
            suggestions.push(compactOption(formatPrimaryInvocationWithArgs(name, '--Claude'), name === 'login' ? '登录 Claude 账号' : desc));
            suggestions.push(compactOption(formatPrimaryInvocationWithArgs(name, '--codex'), codexVariants[name]));
        } else {
            suggestions.push(compactOption(formatPrimaryInvocation(name), desc));
        }
    }

    return {
        message: [],
        action: 'none',
        suggestions,
    };
}

/**
 * Keep the console's primary actions distinct from the maintenance tools.
 */
export function buildConsoleWelcome(): BangCommandResult {
    return {
        message: ['🖥️ 控制台'],
        action: 'none',
        suggestions: [...CONSOLE_MENU_OPTIONS],
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
        return withMainMenuOption(buildHelp(!!ctx.isConsoleSession));
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
