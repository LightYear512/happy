import { writeFileSync } from 'node:fs';
import { logger } from '@/ui/logger';
import { getCurrentCcsProfile } from './ccsProfiles';
import { configuration } from '@/configuration';
import type { BangCommandContext, BangCommandResult } from './types';

export async function handleRestartBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    if (ctx.isConsoleSession) {
        return { message: 'ℹ️ 控制台中请使用 !restart-all 重启全部会话', action: 'none' };
    }
    if (args.trim()) {
        return { message: '!restart 不接受参数', action: 'none' };
    }
    const profile = getCurrentCcsProfile();
    const label = profile ? ` (${profile})` : '';
    logger.debug(`[!restart] Restarting session${label}`);
    return { message: `🔄 正在重启会话${label}`, action: 'restart-session' };
}

export async function handleRestartAllBangCommand(_args: string, _ctx: BangCommandContext): Promise<BangCommandResult> {
    const profile = getCurrentCcsProfile();
    const label = profile ? ` (${profile})` : '';
    try {
        writeFileSync(configuration.restartSignalFile, Date.now().toString(), 'utf-8');
        logger.debug('[!restart-all] Broadcast restart signal written');
    } catch (error) {
        logger.debug('[!restart-all] Failed to write restart signal:', error);
        return { message: '❌ 广播重启信号失败', action: 'none' };
    }
    return { message: `🔄 已广播重启信号到全部会话${label}`, action: 'none' };
}
