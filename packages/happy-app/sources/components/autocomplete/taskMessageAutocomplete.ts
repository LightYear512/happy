export interface TaskMessageOption {
    label: string;
    value?: string;
    disabled?: boolean;
}

export interface TaskMessageGroup {
    messageId: string;
    infoLabel: string;
    ackValue: string;
    dismissValue: string;
}

const TASK_MESSAGE_INFO_LABEL = /^任务消息(?:\s+(\d+))?｜来源\s+([^｜]+)｜发送\s+([^｜]+)｜([\s\S]*)$/;
const TASK_MESSAGE_ACTION_COMMAND = /^@(task-ack|task-dismiss)\s+(\S+)/;

export function splitTaskMessageLabel(label: string): { title: string; preview: string } {
    const match = TASK_MESSAGE_INFO_LABEL.exec(label);
    if (!match) {
        return { title: '任务消息', preview: label };
    }
    return {
        title: `任务消息 | 来源 ${match[2]} | 发送 ${match[3]}`,
        preview: match[4],
    };
}

function taskMessageInfoIndex(label: string): number | null {
    const match = TASK_MESSAGE_INFO_LABEL.exec(label);
    if (!match?.[1]) return null;
    const index = Number(match[1]);
    return Number.isSafeInteger(index) && index > 0 ? index : null;
}

function fallbackTaskMessageInfoLabel(index: number | null): string {
    const suffix = index ? `第 ${index} 条任务消息` : '任务消息';
    return `任务消息｜来源 未知｜发送 时间未知｜${suffix}`;
}

function taskMessageActionCommand(option: TaskMessageOption): string | null {
    const value = option.value?.trim();
    if (value && TASK_MESSAGE_ACTION_COMMAND.test(value)) return value;

    const labelCommand = option.label.trim().split(/[｜|]/, 1)[0].trim();
    return TASK_MESSAGE_ACTION_COMMAND.test(labelCommand) ? labelCommand : null;
}

function taskMessageActionIndex(option: TaskMessageOption): number | null {
    const direct = /^(\d+)\s+/.exec(option.label.trim());
    const fromSuffix = /[｜|]\s*(\d+)\s+/.exec(option.label);
    const raw = direct?.[1] ?? fromSuffix?.[1];
    if (!raw) return null;
    const index = Number(raw);
    return Number.isSafeInteger(index) && index > 0 ? index : null;
}

function parseTaskMessageAction(option: TaskMessageOption): {
    kind: 'ack' | 'dismiss';
    value: string;
    messageId: string;
    index: number | null;
} | null {
    const command = taskMessageActionCommand(option);
    if (!command) return null;
    const match = TASK_MESSAGE_ACTION_COMMAND.exec(command);
    if (!match) return null;
    if (!match[2].startsWith('TM-')) return null;
    return {
        kind: match[1] === 'task-ack' ? 'ack' : 'dismiss',
        value: command,
        messageId: match[2],
        index: taskMessageActionIndex(option),
    };
}

export function collectTaskMessageGroupsFromOptions(
    options: TaskMessageOption[],
    infoLabelsByIndex: Map<number, string> = new Map(),
): TaskMessageGroup[] {
    const groups: TaskMessageGroup[] = [];
    const consumed = new Set<number>();
    for (let index = 0; index < options.length; index++) {
        const option = options[index];
        if (!option?.disabled || !TASK_MESSAGE_INFO_LABEL.test(option.label)) continue;
        const ack = options[index + 1] ? parseTaskMessageAction(options[index + 1]) : null;
        const dismiss = options[index + 2] ? parseTaskMessageAction(options[index + 2]) : null;
        if (ack?.kind !== 'ack' || dismiss?.kind !== 'dismiss' || ack.messageId !== dismiss.messageId) continue;
        groups.push({
            messageId: ack.messageId,
            infoLabel: option.label,
            ackValue: ack.value,
            dismissValue: dismiss.value,
        });
        consumed.add(index);
        consumed.add(index + 1);
        consumed.add(index + 2);
    }

    const actionGroups = new Map<string, {
        index: number | null;
        ack?: ReturnType<typeof parseTaskMessageAction>;
        dismiss?: ReturnType<typeof parseTaskMessageAction>;
    }>();
    for (let optionIndex = 0; optionIndex < options.length; optionIndex++) {
        if (consumed.has(optionIndex)) continue;
        const action = parseTaskMessageAction(options[optionIndex]);
        if (!action) continue;
        const key = action.messageId;
        const current = actionGroups.get(key) ?? { index: action.index };
        if (current.index == null && action.index != null) current.index = action.index;
        current[action.kind] = action;
        actionGroups.set(key, current);
    }
    for (const [messageId, group] of actionGroups) {
        if (!group.ack || !group.dismiss) continue;
        groups.push({
            messageId,
            infoLabel: group.index != null
                ? infoLabelsByIndex.get(group.index) ?? fallbackTaskMessageInfoLabel(group.index)
                : fallbackTaskMessageInfoLabel(null),
            ackValue: group.ack.value,
            dismissValue: group.dismiss.value,
        });
    }

    return groups;
}

function collectTaskMessageInfoLabels(text: string): Map<number, string> {
    const labels = new Map<number, string>();
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        const index = taskMessageInfoIndex(line);
        if (index != null && !labels.has(index)) labels.set(index, line);
    }
    return labels;
}

function decodeOptionText(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&');
}

export function extractTaskMessageGroupsFromText(text: string): TaskMessageGroup[] {
    if (!text.includes('@task-ack ') || !text.includes('<options>')) return [];
    const optionPattern = /<option(?:\s+(?<attrs>[^>]*))?>(?<label>[\s\S]*?)<\/option>/g;
    const options: TaskMessageOption[] = [];
    for (const match of text.matchAll(optionPattern)) {
        const attrs = match.groups?.attrs || '';
        const valueMatch = /(?:^|\s)value\s*=\s*"([^"]+)"/.exec(attrs);
        options.push({
            label: decodeOptionText((match.groups?.label || '').trim()),
            value: valueMatch ? decodeOptionText(valueMatch[1]) : undefined,
            disabled: /(?:^|\s)disabled(?:\s*=\s*"true")?(?:\s|$)/.test(attrs),
        });
    }
    return collectTaskMessageGroupsFromOptions(options, collectTaskMessageInfoLabels(text));
}
