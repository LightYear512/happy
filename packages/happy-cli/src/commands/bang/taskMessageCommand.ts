import type { BangCommandContext, BangCommandResult, BangOptionSuggestion } from './types';
import { currentHappyId, findHtaskRoot, readHtaskCurrent, resolveHtaskHappyId, runHtask } from './htaskCommand';

const HTASK_SAFE_REF = /^[A-Za-z0-9_.-]+$/;
const TASK_MESSAGE_MENU_TTL_MS = 10 * 60 * 1000;

type TaskMessageMenuSnapshot = {
    nextMenuId: number;
    refs: Map<string, { messageId: string; expiresAt: number }>;
};

const taskMessageMenuSnapshots = new Map<string, TaskMessageMenuSnapshot>();

function taskMessageSnapshotKey(ctx: BangCommandContext): string {
    return currentHappyId(ctx) || 'default';
}

function pruneTaskMessageMenuSnapshot(snapshot: TaskMessageMenuSnapshot, now = Date.now()): void {
    for (const [ref, entry] of snapshot.refs) {
        if (entry.expiresAt <= now) snapshot.refs.delete(ref);
    }
}

function rememberTaskMessageMenu(ctx: BangCommandContext, messages: Record<string, unknown>[]): string[] {
    const now = Date.now();
    const key = taskMessageSnapshotKey(ctx);
    const snapshot = taskMessageMenuSnapshots.get(key) ?? { nextMenuId: 0, refs: new Map() };
    pruneTaskMessageMenuSnapshot(snapshot, now);
    snapshot.nextMenuId = snapshot.nextMenuId >= 9999 ? 1 : snapshot.nextMenuId + 1;
    const menuId = snapshot.nextMenuId;
    const menuRefs: string[] = [];

    messages.forEach((message, index) => {
        const messageId = typeof message.message_id === 'string' ? message.message_id : '';
        if (!HTASK_SAFE_REF.test(messageId)) return;
        const ref = `m${menuId}-${index + 1}`;
        snapshot.refs.set(ref, { messageId, expiresAt: now + TASK_MESSAGE_MENU_TTL_MS });
        menuRefs.push(ref);
    });
    taskMessageMenuSnapshots.set(key, snapshot);
    return menuRefs;
}

function parseMessageId(args: string, ctx: BangCommandContext): string | null {
    const messageRef = args.trim().split(/\s+/, 1)[0] || '';
    if (!HTASK_SAFE_REF.test(messageRef)) return null;

    const snapshot = taskMessageMenuSnapshots.get(taskMessageSnapshotKey(ctx));
    if (snapshot) {
        pruneTaskMessageMenuSnapshot(snapshot);
        const entry = snapshot.refs.get(messageRef);
        if (entry) return entry.messageId;
    }

    return messageRef.startsWith('TM-') ? messageRef : null;
}

function scrubMessageId(text: string, messageId: string): string {
    return text.replaceAll(messageId, '该消息');
}

function previewTaskMessageBody(body: unknown): string {
    const text = typeof body === 'string'
        ? body.replace(/\s+/g, ' ').trim()
        : '';
    if (!text) return '无正文';
    const chars = Array.from(text);
    if (chars.length <= 400) return text;
    return `${chars.slice(0, 200).join('')} … ${chars.slice(-200).join('')}`;
}

function formatTaskMessageTime(createdAt: unknown): string {
    if (typeof createdAt !== 'string' || !createdAt.trim()) return '时间未知';
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return createdAt.trim();
    const pad = (value: number) => value.toString().padStart(2, '0');
    return [
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    ].join(' ');
}

function isTaskMessageRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isDeliveredUnhandledMessage(message: Record<string, unknown>): boolean {
    return message.status === 'delivered' && !message.acked_at && !message.dismissed_at && typeof message.message_id === 'string';
}

function taskMessageInfoLine(message: Record<string, unknown>, index: number): string {
    const source = typeof message.from_task_id === 'string' && message.from_task_id ? message.from_task_id : '外部';
    const sentAt = formatTaskMessageTime(message.created_at);
    const preview = previewTaskMessageBody(message.body);
    return `任务消息 ${index}｜来源 ${source}｜发送 ${sentAt}｜${preview}`;
}

export function buildTaskMessageActionSuggestions(messages: Record<string, unknown>[]): BangOptionSuggestion[] {
    return messages.flatMap((message, index) => {
        const messageId = typeof message.message_id === 'string' ? message.message_id : '';
        if (!HTASK_SAFE_REF.test(messageId)) return [];
        return [
            {
                label: `${index + 1} 已处理，确认`,
                value: `@task-ack ${messageId}`,
            },
            {
                label: `${index + 1} 重复/不处理，忽略`,
                value: `@task-dismiss ${messageId}`,
            },
        ];
    });
}

async function readDeliveredUnhandledMessages(ctx: BangCommandContext): Promise<Record<string, unknown>[]> {
    const root = findHtaskRoot();
    if (!root) return [];

    const nativeSessionId = currentHappyId(ctx);
    const happyId = resolveHtaskHappyId(root, nativeSessionId);
    if (!happyId) return [];

    const current = await readHtaskCurrent(root, happyId);
    const taskId = current?.task_id;
    if (typeof taskId !== 'string' || !HTASK_SAFE_REF.test(taskId)) return [];

    const result = await runHtask(root, [
        'message-list',
        '--task-id',
        taskId,
        '--status',
        'delivered',
    ]);
    if (result.code !== 0) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(result.stdout);
    } catch {
        return [];
    }
    return isTaskMessageRecord(parsed) && Array.isArray(parsed.messages)
        ? parsed.messages.filter(isTaskMessageRecord).filter(isDeliveredUnhandledMessage)
        : [];
}

export async function buildTaskMessageMenuSuggestions(ctx: BangCommandContext): Promise<BangOptionSuggestion[]> {
    const messages = await readDeliveredUnhandledMessages(ctx);
    if (messages.length === 0) return [];
    return [`@task｜任务消息 ${messages.length}`];
}

export async function handleTaskMessagesBangCommand(_args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const messages = await readDeliveredUnhandledMessages(ctx);
    if (messages.length === 0) {
        return {
            message: '没有待处理任务消息。',
            action: 'none',
        };
    }
    return {
        message: messages.map(taskMessageInfoLine).join('\n'),
        action: 'none',
        suggestions: buildTaskMessageActionSuggestions(messages),
    };
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

    const messageId = parseMessageId(args, ctx);
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
