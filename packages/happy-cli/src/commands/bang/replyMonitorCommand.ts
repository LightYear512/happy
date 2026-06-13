import type { BangCommandContext, BangCommandResult } from './types';
import { currentHappyId, findHtaskRoot, htaskBlock, resolveHtaskHappyId, runHtask } from './htaskCommand';

function replyMonitorBlock(text: string): string | null {
    return htaskBlock(text, /@reply-monitor (?:已|未修改)/);
}

export async function handleReplyMonitorBangCommand(_args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const root = findHtaskRoot();
    if (!root) {
        return {
            message: '⚠️ 当前目录未发现 .agents/htask/htask.py，无法切换回复监控。',
            action: 'none',
        };
    }

    const nativeSessionId = currentHappyId(ctx);
    const happyId = resolveHtaskHappyId(root, nativeSessionId);
    const payload = JSON.stringify({
        session_id: happyId || nativeSessionId,
        native_session_id: nativeSessionId,
        prompt: '@reply-monitor',
    });
    const result = await runHtask(root, ['inject', '--stdin-hook'], payload);
    if (result.code !== 0) {
        return {
            message: `⚠️ @reply-monitor 执行失败: ${(result.stderr || result.stdout || `exit ${result.code}`).trim()}`,
            action: 'none',
        };
    }

    return {
        message: replyMonitorBlock(result.stdout) || '⚠️ @reply-monitor 未返回回复监控结果。',
        action: 'none',
    };
}
