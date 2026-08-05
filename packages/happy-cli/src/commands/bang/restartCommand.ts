import { logger } from '@/ui/logger';
import { getCurrentCcsProfile, getCurrentCodexProfile } from './ccsProfiles';
import type { BangCommandContext, BangCommandResult } from './types';

/**
 * Handle the `!restart` bang command.
 *
 * In normal sessions:
 * - `!restart` — Restart the current session (keep same account)
 */
export async function handleRestartBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const trimmed = args.trim().toLowerCase();

    if (ctx.isConsoleSession) {
        return {
            message: ['ℹ️ 控制台不批量重启会话；请在目标会话中使用 !restart'],
            action: 'none',
        };
    }

    // Normal session: only no-arg restart is valid
    if (!trimmed) {
        // Local mode sessions cannot be restarted via bang command
        if (ctx.session?.mode === 'local') {
            return {
                message: 'ℹ️ local 模式下请直接在终端重启，或发消息切换 remote 后 !restart',
                action: 'none',
            };
        }
        return restartCurrent(ctx.flavor);
    }

    return {
        message: ['ℹ️ !restart 不接受参数', '用法: !restart → 重启当前会话'],
        action: 'none',
    };
}

/**
 * Restart the current session only.
 */
function restartCurrent(flavor?: 'claude' | 'codex' | 'gemini'): BangCommandResult {
    const currentProfile = flavor === 'codex' ? getCurrentCodexProfile() : getCurrentCcsProfile();
    const profileLabel = currentProfile ? ` (${currentProfile})` : '';

    logger.debug(`[!restart] Restarting current session${profileLabel} [flavor=${flavor ?? 'claude'}]`);

    return { message: `🔄 正在重启会话${profileLabel}`, action: 'restart-session' };
}
