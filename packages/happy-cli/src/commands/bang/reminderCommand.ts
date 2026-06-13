import type { BangCommandContext, BangCommandResult } from './types';
import { buildHtaskPromptPayload, currentHappyId, findHtaskRoot, htaskBlock, resolveHtaskHappyId, runHtask } from './htaskCommand';

function reminderBlock(text: string): string | null {
    return htaskBlock(text, /@reminder (?:已|未修改)/);
}

export async function handleReminderBangCommand(_args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const root = findHtaskRoot();
    if (!root) {
        return {
            message: '⚠️ 当前目录未发现 .agents/htask/htask.py，无法切换任务提醒。',
            action: 'none',
        };
    }

    const nativeSessionId = currentHappyId(ctx);
    const happyId = resolveHtaskHappyId(root, nativeSessionId);
    const payload = buildHtaskPromptPayload(nativeSessionId, happyId, '@reminder');
    const result = await runHtask(root, ['inject', '--stdin-hook'], payload);
    if (result.code !== 0) {
        return {
            message: `⚠️ @reminder 执行失败: ${(result.stderr || result.stdout || `exit ${result.code}`).trim()}`,
            action: 'none',
        };
    }

    return {
        message: reminderBlock(result.stdout) || '⚠️ @reminder 未返回任务提醒结果。',
        action: 'none',
    };
}
