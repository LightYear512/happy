/**
 * `!open <id>` bang command — Open a Claude Code session.
 *
 * Finds the matching Claude session by ID prefix, determines its working
 * directory, and asks the daemon to spawn a new happy-cli session with --resume.
 */

import { logger } from '@/ui/logger';
import { spawnDaemonSession } from '@/daemon/controlClient';
import { scanClaudeSessions, formatAllSessionsListing } from './sessionCommand';
import type { BangCommandContext, BangCommandResult } from './types';

/**
 * Handle the `!open` bang command.
 *
 * - `!open <id-prefix>` — Open a session matching the prefix
 * - `!open` (no args) — Show all recent sessions with quick-open buttons
 */
export async function handleOpenBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const prefix = args.trim().toLowerCase();

    // Scan all sessions
    const sessions = await scanClaudeSessions();

    if (!prefix) {
        if (sessions.length === 0) {
            return { message: '📭 没有找到可恢复的会话', action: 'none' };
        }
        return formatAllSessionsListing(sessions);
    }

    const matches = sessions.filter(s => s.sessionId.toLowerCase().startsWith(prefix));

    if (matches.length === 0) {
        return {
            message: [`❌ 未找到匹配 "${prefix}" 的会话`, '使用 !session 查看可用会话'],
            action: 'none',
            suggestions: ['!session'],
        };
    }

    if (matches.length > 1) {
        const messages = [`⚠️ "${prefix}" 匹配了 ${matches.length} 个会话`];
        const matchLines: string[] = [];
        const suggestions: string[] = [];
        for (const s of matches) {
            const shortId = s.sessionId.slice(0, 12);
            const dir = s.cwd ? s.cwd.split(/[/\\]/).pop() || s.projectDir : s.projectDir;
            matchLines.push(`${shortId} | ${dir}`);
            suggestions.push(`!open ${shortId}`);
        }
        messages.push(matchLines.join('\n'));
        messages.push('请提供更长的前缀');
        return { message: messages, action: 'none', suggestions };
    }

    const session = matches[0];

    if (!session.cwd) {
        return {
            message: [`❌ 无法打开会话 ${session.sessionId.slice(0, 8)}`, '会话文件中缺少工作目录信息'],
            action: 'none',
        };
    }

    const directory = session.cwd;

    logger.debug(`[!open] Resuming session ${session.sessionId} in ${directory}`);

    // Ask daemon to spawn a new session with --resume
    try {
        const result = await spawnDaemonSession(directory, undefined, session.sessionId, session.preview || undefined);

        if (result.error) {
            return {
                message: ['❌ 打开会话失败', result.error],
                action: 'none',
            };
        }

        const shortId = session.sessionId.slice(0, 8);
        const dir = directory.split(/[/\\]/).pop() || directory;
        return {
            message: [`✅ 正在打开会话 ${shortId}`, `目录: ${dir}`, '新会话将在 App 中出现'],
            action: 'none',
        };
    } catch (error) {
        logger.debug('[!open] Failed to spawn session:', error);
        return {
            message: ['❌ 打开会话失败', error instanceof Error ? error.message : 'Unknown error'],
            action: 'none',
        };
    }
}

