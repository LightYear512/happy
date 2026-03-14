import { writeFileSync } from 'node:fs';
import { logger } from '@/ui/logger';
import { getCurrentCcsProfile } from './ccsProfiles';
import { configuration } from '@/configuration';
import { centerText } from './format';
import type { BangCommandContext, BangCommandResult } from './types';

/**
 * Handle the `!restart` bang command.
 *
 * - `!restart` — Restart the current session (keep same account)
 * - `!restart all` — Restart all sessions on this machine (keep same account)
 */
export async function handleRestartBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const trimmed = args.trim().toLowerCase();

    if (trimmed === 'all') {
        return restartAll();
    }

    if (!trimmed) {
        return restartCurrent();
    }

    const lines = [
        '❌ 用法错误',
        '',
        '!restart — 重启当前会话',
        '!restart all — 重启全部会话',
    ];
    return { message: centerText(lines), action: 'none' };
}

/**
 * Restart the current session only.
 */
function restartCurrent(): BangCommandResult {
    const currentProfile = getCurrentCcsProfile();
    const profileLabel = currentProfile ? ` (${currentProfile})` : '';

    logger.debug(`[!restart] Restarting current session${profileLabel}`);

    const lines = [`🔄 正在重启会话${profileLabel}`];
    return { message: centerText(lines), action: 'restart-session' };
}

/**
 * Restart all sessions on this machine by writing a timestamp to the
 * restart-signal file. Other sessions detect this via fs.watch and restart.
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
        const lines = [
            `🔄 正在重启当前会话${profileLabel}`,
            '',
            '广播到其他会话失败。',
        ];
        return { message: centerText(lines), action: 'restart-session' };
    }

    const lines = [
        `🔄 正在重启全部会话${profileLabel}`,
    ];
    return { message: centerText(lines), action: 'restart-session' };
}
