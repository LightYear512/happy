/**
 * `!resume <id>` bang command — Resume a Claude Code session.
 *
 * Finds the matching Claude session by ID prefix, determines its working
 * directory, and asks the daemon to spawn a new happy-cli session with --resume.
 */

import { logger } from '@/ui/logger';
import { spawnDaemonSession } from '@/daemon/controlClient';
import { scanClaudeSessions, type ClaudeSessionInfo } from './sessionCommand';
import type { BangCommandContext, BangCommandResult } from './types';

/**
 * Handle the `!resume` bang command.
 *
 * - `!resume <id-prefix>` — Resume a session matching the prefix
 * - `!resume` (no args) — Show session list with quick-resume buttons
 */
export async function handleResumeBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const prefix = args.trim().toLowerCase();

    // Scan all sessions
    const sessions = await scanClaudeSessions();

    if (!prefix) {
        return buildSessionList(sessions);
    }

    const matches = sessions.filter(s => s.sessionId.toLowerCase().startsWith(prefix));

    if (matches.length === 0) {
        return {
            message: [`❌ 未找到匹配 "${prefix}" 的会话`, '使用 !session 查看可用会话'],
            action: 'none',
        };
    }

    if (matches.length > 1) {
        const messages = [`⚠️ "${prefix}" 匹配了 ${matches.length} 个会话`];
        const matchLines: string[] = [];
        for (const s of matches.slice(0, 5)) {
            const shortId = s.sessionId.slice(0, 12);
            const dir = s.cwd ? s.cwd.split(/[/\\]/).pop() || s.projectDir : s.projectDir;
            matchLines.push(`${shortId} | ${dir}`);
        }
        messages.push(matchLines.join('\n'));
        messages.push('请提供更长的前缀');
        return { message: messages, action: 'none' };
    }

    const session = matches[0];

    if (!session.cwd) {
        return {
            message: [`❌ 无法恢复会话 ${session.sessionId.slice(0, 8)}`, '会话文件中缺少工作目录信息'],
            action: 'none',
        };
    }

    const directory = session.cwd;

    logger.debug(`[!resume] Resuming session ${session.sessionId} in ${directory}`);

    // Ask daemon to spawn a new session with --resume
    try {
        const result = await spawnDaemonSession(directory, undefined, session.sessionId, session.preview || undefined);

        if (result.error) {
            return {
                message: ['❌ 恢复会话失败', result.error],
                action: 'none',
            };
        }

        const shortId = session.sessionId.slice(0, 8);
        const dir = directory.split(/[/\\]/).pop() || directory;
        return {
            message: [`✅ 正在恢复会话 ${shortId}`, `目录: ${dir}`, '新会话将在 App 中出现'],
            action: 'none',
        };
    } catch (error) {
        logger.debug('[!resume] Failed to spawn session:', error);
        return {
            message: ['❌ 恢复会话失败', error instanceof Error ? error.message : 'Unknown error'],
            action: 'none',
        };
    }
}

/** Max sessions to show in the quick-resume list */
const MAX_RESUME_LIST = 8;

/** Short ID length for display and suggestion buttons */
const SHORT_ID_LEN = 8;

/**
 * Build a session list with per-session suggestion buttons for quick resume.
 */
function buildSessionList(sessions: ClaudeSessionInfo[]): BangCommandResult {
    if (sessions.length === 0) {
        return { message: '📭 没有找到可恢复的会话', action: 'none' };
    }

    const displayed = sessions.slice(0, MAX_RESUME_LIST);
    const messages: string[] = [`📋 选择要恢复的会话 (${displayed.length}/${sessions.length})`];
    const suggestions: string[] = [];

    for (const s of displayed) {
        const shortId = s.sessionId.slice(0, SHORT_ID_LEN);
        const dir = s.cwd ? s.cwd.replace(/\\/g, '/').split('/').pop() || s.projectDir : s.projectDir;
        const preview = s.preview ? s.preview.replace(/\n/g, ' ').trim().slice(0, 30) : '';
        const label = preview ? `${dir} — ${preview}` : dir;

        messages.push(`  [${shortId}] ${label}`);
        suggestions.push(`!resume ${shortId}`);
    }

    return { message: messages, action: 'none', suggestions };
}
