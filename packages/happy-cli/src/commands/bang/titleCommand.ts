/**
 * `!title` bang command — Change the current chat session title.
 *
 * Usage: `!title <新标题>`
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import type { BangCommandContext, BangCommandResult } from './types';

export async function handleTitleBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const title = args.trim();

    if (!title) {
        return {
            message: ['用法: !title <新标题>', '', '修改当前会话的标题'],
            action: 'none',
        };
    }

    try {
        ctx.client.sendClaudeSessionMessage({
            type: 'summary',
            summary: title,
            leafUuid: randomUUID(),
        });
        logger.debug(`[!title] Changed title to: ${title}`);
        return {
            message: `✅ 标题已修改为: "${title}"`,
            action: 'none',
        };
    } catch (error) {
        logger.debug('[!title] Failed to change title:', error);
        return {
            message: `❌ 修改标题失败: ${(error as Error).message}`,
            action: 'none',
        };
    }
}
