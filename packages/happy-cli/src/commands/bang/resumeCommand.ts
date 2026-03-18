/**
 * `!resume <id>` bang command — Resume a Claude Code session.
 *
 * Finds the matching Claude session by ID prefix, determines its working
 * directory, and asks the daemon to spawn a new happy-cli session with --resume.
 */

import { logger } from '@/ui/logger';
import { spawnDaemonSession } from '@/daemon/controlClient';
import { scanClaudeSessions } from './sessionsCommand';
import { centerText } from './format';
import type { BangCommandContext, BangCommandResult } from './types';

/**
 * Handle the `!resume` bang command.
 *
 * - `!resume <id-prefix>` — Resume a session matching the prefix
 * - `!resume` (no args) — Show usage hint
 */
export async function handleResumeBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const prefix = args.trim().toLowerCase();

    if (!prefix) {
        const lines = [
            '用法: !resume <id前缀>',
            '',
            '先使用 !sessions 查看可用会话',
        ];
        return { message: centerText(lines), action: 'none' };
    }

    // Scan all sessions and find matching ones
    const sessions = await scanClaudeSessions();

    const matches = sessions.filter(s => s.sessionId.toLowerCase().startsWith(prefix));

    if (matches.length === 0) {
        const lines = [
            `❌ 未找到匹配 "${prefix}" 的会话`,
            '',
            '使用 !sessions 查看可用会话',
        ];
        return { message: centerText(lines), action: 'none' };
    }

    if (matches.length > 1) {
        const lines = [
            `⚠️ "${prefix}" 匹配了 ${matches.length} 个会话`,
            '',
        ];
        for (const s of matches.slice(0, 5)) {
            const shortId = s.sessionId.slice(0, 12);
            const dir = s.cwd ? s.cwd.split(/[/\\]/).pop() || s.projectDir : s.projectDir;
            lines.push(`${shortId} | ${dir}`);
        }
        lines.push('');
        lines.push('请提供更长的前缀');
        return { message: centerText(lines), action: 'none' };
    }

    const session = matches[0];

    if (!session.cwd) {
        const lines = [
            `❌ 无法恢复会话 ${session.sessionId.slice(0, 8)}`,
            '',
            '会话文件中缺少工作目录信息',
        ];
        return { message: centerText(lines), action: 'none' };
    }

    const directory = session.cwd;

    logger.debug(`[!resume] Resuming session ${session.sessionId} in ${directory}`);

    // Ask daemon to spawn a new session with --resume
    try {
        const result = await spawnDaemonSession(directory, undefined, session.sessionId);

        if (result.error) {
            const lines = [
                '❌ 恢复会话失败',
                '',
                result.error,
            ];
            return { message: centerText(lines), action: 'none' };
        }

        const shortId = session.sessionId.slice(0, 8);
        const dir = directory.split(/[/\\]/).pop() || directory;
        const lines = [
            `✅ 正在恢复会话 ${shortId}`,
            '',
            `目录: ${dir}`,
            '新会话将在 App 中出现',
        ];
        return { message: centerText(lines), action: 'none' };
    } catch (error) {
        logger.debug('[!resume] Failed to spawn session:', error);
        const lines = [
            '❌ 恢复会话失败',
            '',
            error instanceof Error ? error.message : 'Unknown error',
        ];
        return { message: centerText(lines), action: 'none' };
    }
}
