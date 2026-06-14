import { describe, expect, it } from 'vitest';
import {
    collectTaskMessageGroupsFromOptions,
    extractTaskMessageGroupsFromText,
    splitTaskMessageLabel,
} from './taskMessageAutocomplete';

describe('taskMessageAutocomplete', () => {
    it('collects structured options with hidden durable action values', () => {
        const groups = collectTaskMessageGroupsFromOptions([
            {
                label: '任务消息｜来源 HT-0282｜发送 2026-06-13 23:26｜需要确认 Phase2 syntax readiness',
                disabled: true,
            },
            { label: '已处理，确认', value: '@task-ack TM-2026-06-13T152633-813599Z-ef493ff1c5' },
            { label: '重复/不处理，忽略', value: '@task-dismiss TM-2026-06-13T152633-813599Z-ef493ff1c5' },
        ]);

        expect(groups).toEqual([
            {
                messageId: 'TM-2026-06-13T152633-813599Z-ef493ff1c5',
                infoLabel: '任务消息｜来源 HT-0282｜发送 2026-06-13 23:26｜需要确认 Phase2 syntax readiness',
                ackValue: '@task-ack TM-2026-06-13T152633-813599Z-ef493ff1c5',
                dismissValue: '@task-dismiss TM-2026-06-13T152633-813599Z-ef493ff1c5',
            },
        ]);
    });

    it('extracts @task menu actions from plain info lines plus structured option values', () => {
        const groups = extractTaskMessageGroupsFromText([
            '任务消息 1｜来源 HT-0282｜发送 2026-06-13 23:26｜Phase2 syntax readiness request',
            '<options>',
            '<option value="@task-ack TM-2026-06-13T152633-813599Z-ef493ff1c5">1 已处理，确认</option>',
            '<option value="@task-dismiss TM-2026-06-13T152633-813599Z-ef493ff1c5">1 重复/不处理，忽略</option>',
            '</options>',
        ].join('\n'));

        expect(groups).toHaveLength(1);
        expect(groups[0].messageId).toBe('TM-2026-06-13T152633-813599Z-ef493ff1c5');
        expect(groups[0].infoLabel).toBe('任务消息 1｜来源 HT-0282｜发送 2026-06-13 23:26｜Phase2 syntax readiness request');
        expect(splitTaskMessageLabel(groups[0].infoLabel)).toEqual({
            title: '任务消息 | 来源 HT-0282 | 发送 2026-06-13 23:26',
            preview: 'Phase2 syntax readiness request',
        });
    });

    it('keeps durable legacy label-only @task action options recoverable', () => {
        const groups = extractTaskMessageGroupsFromText([
            '任务消息 1｜来源 HT-0282｜发送 2026-06-13 23:26｜Legacy durable task action',
            '<options>',
            '<option>@task-ack TM-2026-06-13T152633-813599Z-ef493ff1c5｜1 已处理，确认</option>',
            '<option>@task-dismiss TM-2026-06-13T152633-813599Z-ef493ff1c5｜1 重复/不处理，忽略</option>',
            '</options>',
        ].join('\n'));

        expect(groups).toEqual([
            {
                messageId: 'TM-2026-06-13T152633-813599Z-ef493ff1c5',
                infoLabel: '任务消息 1｜来源 HT-0282｜发送 2026-06-13 23:26｜Legacy durable task action',
                ackValue: '@task-ack TM-2026-06-13T152633-813599Z-ef493ff1c5',
                dismissValue: '@task-dismiss TM-2026-06-13T152633-813599Z-ef493ff1c5',
            },
        ]);
    });

    it('does not resurrect process-local short refs from history as durable actions', () => {
        const groups = extractTaskMessageGroupsFromText([
            '任务消息 1｜来源 HT-0282｜发送 2026-06-13 23:26｜Legacy short-ref task action',
            '<options>',
            '<option>@task-ack m7-1｜1 已处理，确认</option>',
            '<option>@task-dismiss m7-1｜1 重复/不处理，忽略</option>',
            '</options>',
        ].join('\n'));

        expect(groups).toEqual([]);
    });
});
