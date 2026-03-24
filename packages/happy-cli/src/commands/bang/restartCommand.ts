import { writeFileSync } from 'node:fs';
import { logger } from '@/ui/logger';
import { getCurrentCcsProfile } from './ccsProfiles';
import { configuration } from '@/configuration';
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
            message: ['ℹ️ 控制台中请使用 !restart-all 重启全部会话'],
            action: 'none',
            suggestions: ['!restart-all'],
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
        return restartCurrent();
    }

    return {
        message: ['用法: !restart → 重启当前会话'],
        action: 'none',
    };
}

/**
 * Handle the `!restart-all` bang command (console only).
 *
 * Broadcast restart to all sessions on this machine.
 */
export async function handleRestartAllBangCommand(_args: string, _ctx: BangCommandContext): Promise<BangCommandResult> {
    return restartAll();
}

/**
 * Restart the current session only.
 */
function restartCurrent(): BangCommandResult {
    const currentProfile = getCurrentCcsProfile();
    const profileLabel = currentProfile ? ` (${currentProfile})` : '';

    logger.debug(`[!restart] Restarting current session${profileLabel}`);

    return { message: `🔄 正在重启会话${profileLabel}`, action: 'restart-session' };
}

/**
 * Restart all sessions on this machine by writing a timestamp to the
 * restart-signal file. Other sessions detect this via fs.watch and restart.
 * Console doesn't need restart-session since it has no Claude SDK.
 */
function restartAll(): BangCommandResult {
    const currentProfile = getCurrentCcsProfile();
    const profileLabel = currentProfile ? ` (${currentProfile})` : '';

    logger.debug(`[!restart] Broadcasting restart to all sessions${profileLabel}`);

    try {
        writeFileSync(configuration.restartSignalFile, Date.now().toString(), 'utf-8');
        logger.debug(`[!restart] Wrote restart signal: ${configuration.restartSignalFile}`);
    } catch (err) {
        logger.debug('[!restart] Failed to write restart signal file:', err);
        return {
            message: ['❌ 广播重启信号失败'],
            action: 'none',
        };
    }

    return { message: `🔄 已广播重启信号到全部会话${profileLabel}`, action: 'none' };
}
