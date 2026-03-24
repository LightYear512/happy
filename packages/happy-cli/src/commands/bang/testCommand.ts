/**
 * `!test` bang command — Simulate bang command outputs for visual testing.
 *
 * Console-only, hidden from !help. Used during development to verify
 * mobile chat bubble rendering of all command outputs.
 *
 * - `!test` — Show all test cases
 * - `!test <command>` — Show test cases for a specific command
 * - `!test <unknown>` — Show edge case outputs (unknown command, blocked, etc.)
 */

import { SEPARATOR, codeBlock, type BangCommandContext, type BangCommandResult } from './types';
import { formatUsage, type UsageData } from './usageCommand';

function label(text: string): string {
    return `📌 ${text}`;
}

function testHelp(): string[] {
    return [
        label('!help 输出'),
        '📖 快捷命令',
        SEPARATOR,
        '!usage (!u) → 查看 API 用量',
        '!session (!s) → 查看可恢复会话',
        '!open (!o) → 打开会话',
        '!help (!h) → 显示帮助',
        SEPARATOR,
    ];
}

/** Mock UsageData for visual testing — calls real formatUsage() to guarantee output consistency. */
const mockUsageData: UsageData = {
    five_hour: { utilization: 18, resets_at: new Date(Date.now() + 4 * 3600_000 + 14 * 60_000).toISOString() },
    seven_day: { utilization: 42, resets_at: new Date(Date.now() + 5 * 86400_000 + 3 * 3600_000).toISOString() },
    seven_day_oauth_apps: null,
    seven_day_opus: { utilization: 65, resets_at: new Date(Date.now() + 5 * 86400_000).toISOString() },
    seven_day_sonnet: { utilization: 12, resets_at: new Date(Date.now() + 5 * 86400_000).toISOString() },
    seven_day_cowork: null,
    extra_usage: null,
};

function testUsage(): string[] {
    return [
        label('!usage 选择账户'),
        '📊 请选择要查询的账户:',
        SEPARATOR,
        'hassel',
        'chulai (默认)',
        SEPARATOR,
        '用法: !usage <账户名>',

        label('!usage 查询结果'),
        ...formatUsage(mockUsageData, 'hassel', Date.now()),

        label('!usage 获取失败'),
    ];
}

function testSessions(): string[] {
    return [
        label('!session 空结果'),
        '📭 没有找到可恢复的会话',

        label('!session 有结果'),
        '📋 可恢复的会话 (3/5)',
        '▸ 今天 ━━━━━━━━━━━━━━━━━━━',
        '  [a1b2c3d4] happy · 5分钟前 — 帮我重构这个组件…',
        '  [e5f6g7h8] workspace · 2小时前 — list files in this…',
        '▸ 3天前 ━━━━━━━━━━━━━━━━━━━',
        '  [i9j0k1l2] project — fix the login bug',
        '',
        '💡 !open <id前缀>',
    ];
}

function testOpen(): string[] {
    return [
        label('!open 无参数'),
        '用法: !open <id前缀>',
        '先使用 !session 查看可用会话',

        label('!open 未找到'),
        '❌ 未找到匹配 "xyz" 的会话',
        '使用 !session 查看可用会话',

        label('!open 多个匹配'),
        '⚠️ "a1b" 匹配了 2 个会话',
        'a1b2c3d4e5f6 | happy\na1b9x8y7z6w5 | workspace',
        '请提供更长的前缀',

        label('!open 成功'),
        '✅ 正在打开会话 a1b2c3d4',
        '目录: happy',
        '新会话将在 App 中出现',
    ];
}

function testAuth(): string[] {
    return [
        label('!auth 列表（有组）'),
        '📋 组 "default"',
        SEPARATOR,
        '● hassel',
        '○ chulai',
        SEPARATOR,
        '!auth <名称> → 当前会话\n!auth all <名称> → 全部会话',

        label('!auth 列表（无配置）'),
        '📋 当前无 CCS 配置。',
        SEPARATOR,
        '○ profile1',
        '○ profile2',
        SEPARATOR,

        label('!auth 切换成功'),
        '✅ 已切换到 "chulai"',
        '📊 5h: 18% · 7d: 42%',

        label('!auth 已是当前'),
        '✅ 当前已是 "hassel"',

        label('!auth 未找到'),
        '❌ 未找到配置 "foo"。',
        '使用 !auth 查看可用账号。',

        label('!auth 无法切换'),
        '❌ 无法切换',
        '"hassel" → 组 "default"',
        '"isolated" → 独立',

        label('!auth all 成功'),
        '✅ 已切换到 "chulai"',
        '组 "default" 中的所有会话',
    ];
}

function testRestart(): string[] {
    return [
        label('!restart 当前'),
        '🔄 正在重启会话 (hassel)',

        label('!restart all'),
        '🔄 正在重启全部会话 (hassel)',

        label('!restart 用法错误'),
        '❌ 用法错误',
        '!restart → 重启当前会话',
        '!restart all → 重启全部会话',
    ];
}

function testLogin(): string[] {
    return [
        label('!login 无参（无账户）'),
        '用法: !login <名称>\n\n创建新账户并登录',

        label('!login 无参（有账户）'),
        '📋 已有账户',
        SEPARATOR,
        'work',
        'personal',
        SEPARATOR,
        '!login <名称> → 重新登录\n!login <新名称> → 创建新账户',

        label('!login 重新登录'),
        '🔐 正在重新登录...\n\n配置: work\n\n请等待登录提示，然后粘贴 OAuth Key\n\n取消: !cancel',

        label('!login 新建'),
        '🔐 正在登录...\n\n配置: newaccount (共享)\n\n请等待登录提示，然后粘贴 OAuth Key\n\n取消: !cancel',
    ];
}

function testEdgeCases(): string[] {
    return [
        label('未知命令'),
        '❌ 未知命令 "!foo"',
        '输入 !help 查看可用命令。',

        label('会话专属命令被阻止'),
        'ℹ️ !auth 仅在 Claude 会话中可用',

        label('控制台专属命令被阻止'),
        'ℹ️ !session 仅在控制台中可用',

        label('取消无操作'),
        'ℹ️ 当前没有进行中的操作',
    ];
}

const testSuites: Record<string, () => string[]> = {
    help: testHelp,
    usage: testUsage,
    session: testSessions,
    open: testOpen,
    auth: testAuth,
    restart: testRestart,
    login: testLogin,
};

/** Send codex-style test messages directly via ctx.client (usage error simulation). */
function sendCodexTests(ctx: BangCommandContext): void {
    ctx.client.sendSessionEvent({ type: 'message', message: '❌ 获取用量失败' });
    ctx.client.sendCodexMessage({ type: 'message', message: codeBlock('The operation was aborted due to timeout') });
}

/** Send options test — clickable quick-reply buttons rendered via MarkdownView <options> block. */
function sendOptionsTest(ctx: BangCommandContext): void {
    ctx.client.sendCodexMessage({ type: 'message', message: '🧪 可点击选项测试\n\n选择一个操作:\n<options>\n<option>!usage</option>\n<option>!session</option>\n<option>!auth</option>\n<option>!help</option>\n</options>' });
    ctx.client.sendCodexMessage({ type: 'message', message: '🧪 内联选项测试\n\n快速切换账户:\n<options>\n<option>!auth hassel</option>\n<option>!auth chulai</option>\n</options>' });
}

export async function handleTestBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const target = args.trim().toLowerCase();

    if (!target) {
        const allNames = [...Object.keys(testSuites), 'options', 'edge'];
        const optionsBlock = '<options>\n' + allNames.map(n => `<option>!test ${n}</option>`).join('\n') + '\n</options>';
        ctx.client.sendCodexMessage({ type: 'message', message: `🧪 测试用例\n\n选择要运行的测试:\n${optionsBlock}` });
        return { message: [], action: 'none' };
    }

    // Run all tests
    if (target === 'all') {
        const messages: string[] = [];
        for (const [name, suite] of Object.entries(testSuites)) {
            messages.push(label(`── ${name} ──`));
            messages.push(...suite());
        }
        messages.push(label('── 边界情况 ──'));
        messages.push(...testEdgeCases());
        for (const msg of messages) {
            ctx.client.sendSessionEvent({ type: 'message', message: msg });
        }
        sendCodexTests(ctx);
        sendOptionsTest(ctx);
        return { message: [], action: 'none' };
    }

    // Options test — needs direct sending via codex messages
    if (target === 'options') {
        sendOptionsTest(ctx);
        return { message: [], action: 'none' };
    }

    // Usage needs codex messages — send directly
    if (target === 'usage') {
        const messages = testUsage();
        for (const msg of messages) {
            ctx.client.sendSessionEvent({ type: 'message', message: msg });
        }
        sendCodexTests(ctx);
        return { message: [], action: 'none' };
    }

    if (target === 'edge') {
        return { message: testEdgeCases(), action: 'none' };
    }

    const suite = testSuites[target];
    if (suite) {
        return { message: suite(), action: 'none' };
    }

    // Unknown target → show edge cases
    return { message: testEdgeCases(), action: 'none' };
}
