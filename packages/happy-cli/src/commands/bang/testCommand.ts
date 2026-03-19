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

import type { BangCommandContext, BangCommandResult } from './types';

const SEPARATOR = '━━━━━━━━━━━━━━━━━━';

function label(text: string): string {
    return `📌 ${text}`;
}

function testHelp(): string[] {
    return [
        label('!help 输出'),
        '📖 快捷命令',
        SEPARATOR,
        '!usage (!u) → 查看 API 用量',
        '!sessions (!s) → 查看可恢复会话',
        '!resume (!re) → 恢复指定会话',
        '!help (!h) → 显示帮助',
        SEPARATOR,
    ];
}

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
        '📊 用量 — hassel',
        '⏱ 5 小时窗口\n[██░░░░░░░░] 18%\n4 小时 14 分钟 后重置',
        '📅 7 天总量\n[████░░░░░░] 42%\n5 天 3 小时 后重置',
    ];
}

function testSessions(): string[] {
    return [
        label('!sessions 空结果'),
        '📭 没有找到可恢复的会话',

        label('!sessions 有结果'),
        '📋 可恢复的会话 (3/3)',
        SEPARATOR,
        'a1b2c3d4 | happy | 5分钟前\n  "帮我重构这个组件..."',
        'e5f6g7h8 | workspace | 2小时前\n  "list files in this directory"',
        'i9j0k1l2 | project | 3天前\n  "fix the login bug"',
        SEPARATOR,
        '用法: !resume <id前缀>',
    ];
}

function testResume(): string[] {
    return [
        label('!resume 无参数'),
        '用法: !resume <id前缀>',
        '先使用 !sessions 查看可用会话',

        label('!resume 未找到'),
        '❌ 未找到匹配 "xyz" 的会话',
        '使用 !sessions 查看可用会话',

        label('!resume 多个匹配'),
        '⚠️ "a1b" 匹配了 2 个会话',
        'a1b2c3d4e5f6 | happy\na1b9x8y7z6w5 | workspace',
        '请提供更长的前缀',

        label('!resume 成功'),
        '✅ 正在恢复会话 a1b2c3d4',
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
        label('!login 提示'),
        '🔑 登录新账号',
        '用法: !login <账户名>',
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
        'ℹ️ !sessions 仅在控制台中可用',

        label('取消无操作'),
        'ℹ️ 当前没有进行中的操作',
    ];
}

const testSuites: Record<string, () => string[]> = {
    help: testHelp,
    usage: testUsage,
    sessions: testSessions,
    resume: testResume,
    auth: testAuth,
    restart: testRestart,
    login: testLogin,
};

export async function handleTestBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const target = args.trim().toLowerCase();

    if (!target) {
        // Run all tests
        const messages: string[] = [];
        for (const [name, suite] of Object.entries(testSuites)) {
            messages.push(label(`── ${name} ──`));
            messages.push(...suite());
        }
        messages.push(label('── 边界情况 ──'));
        messages.push(...testEdgeCases());
        return { message: messages, action: 'none' };
    }

    const suite = testSuites[target];
    if (suite) {
        return { message: suite(), action: 'none' };
    }

    // Unknown target → show edge cases
    return { message: testEdgeCases(), action: 'none' };
}
