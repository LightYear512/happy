import type { BangCommandContext, BangCommandResult } from './types';
import { currentHappyId, findHtaskRoot, resolveHtaskHappyId, runHtask } from './htaskCommand';

const HTASK_SAFE_REF = /^[A-Za-z0-9_.-]+$/;

function parseMessageId(args: string): string | null {
    const messageId = args.trim().split(/\s+/, 1)[0] || '';
    return HTASK_SAFE_REF.test(messageId) ? messageId : null;
}

function scrubMessageId(text: string, messageId: string): string {
    return text.replaceAll(messageId, '该消息');
}

async function runTaskMessageAction(
    args: string,
    ctx: BangCommandContext,
    action: 'ack' | 'dismiss',
): Promise<BangCommandResult> {
    const root = findHtaskRoot();
    if (!root) {
        return {
            message: '⚠️ 当前目录未发现 .agents/htask/htask.py，无法处理任务消息。',
            action: 'none',
        };
    }

    const messageId = parseMessageId(args);
    if (!messageId) {
        return {
            message: '⚠️ 任务消息操作缺少有效消息引用。',
            action: 'none',
        };
    }

    const nativeSessionId = currentHappyId(ctx);
    const happyId = resolveHtaskHappyId(root, nativeSessionId);
    if (!happyId) {
        return {
            message: '⚠️ 无法识别当前 htask 绑定，任务消息未处理。',
            action: 'none',
        };
    }

    const command = action === 'ack' ? 'message-ack' : 'message-dismiss';
    const evidenceArg = action === 'ack' ? '--evidence' : '--reason';
    const evidence = action === 'ack'
        ? '用户通过任务消息菜单确认已处理'
        : '用户通过任务消息菜单选择重复或不处理';
    const result = await runHtask(root, [
        command,
        '--happy',
        happyId,
        '--message-id',
        messageId,
        evidenceArg,
        evidence,
    ]);
    if (result.code !== 0) {
        const detail = scrubMessageId((result.stderr || result.stdout || `exit ${result.code}`).trim(), messageId);
        return {
            message: `⚠️ 任务消息未${action === 'ack' ? '确认' : '忽略'}：${detail}`,
            action: 'none',
        };
    }

    return {
        message: action === 'ack'
            ? '任务消息已确认处理。'
            : '任务消息已忽略，后续不再提醒。',
        action: 'none',
    };
}

export function handleTaskMessageAckBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    return runTaskMessageAction(args, ctx, 'ack');
}

export function handleTaskMessageDismissBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    return runTaskMessageAction(args, ctx, 'dismiss');
}
