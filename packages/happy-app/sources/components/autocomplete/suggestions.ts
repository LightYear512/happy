import { CommandSuggestion, FileMentionSuggestion, TaskMessageSuggestion } from '@/components/AgentInputSuggestionView';
import * as React from 'react';
import { searchFiles, FileItem } from '@/sync/suggestionFile';
import { searchCommands, CommandItem } from '@/sync/suggestionCommands';
import { storage } from '@/sync/storage';
import type { AutocompleteSuggestion } from './types';
import {
    collectTaskMessageGroupsFromOptions,
    extractTaskMessageGroupsFromText,
    splitTaskMessageLabel,
    type TaskMessageGroup,
} from './taskMessageAutocomplete';

const TASK_MESSAGE_ENTRY_TERMS = new Set([
    'task',
    'tasks',
    'message',
    'messages',
    'msg',
    'msgs',
    '任务',
    '消息',
    '任务消息',
]);

export async function getCommandSuggestions(sessionId: string, query: string): Promise<AutocompleteSuggestion[]> {
    // Remove the "/" prefix for searching
    const searchTerm = query.slice(1);

    try {
        // Use the command search cache with fuzzy matching
        const commands = await searchCommands(sessionId, searchTerm, { limit: 5 });

        // Convert CommandItem to suggestion format
        return commands.map((cmd: CommandItem) => ({
            key: `cmd-${cmd.command}`,
            text: `/${cmd.command}`,
            component: () => React.createElement(CommandSuggestion, {
                command: cmd.command,
                description: cmd.description
            })
        }));
    } catch (error) {
        console.error('Error fetching command suggestions:', error);
        // Return empty array on error
        return [];
    }
}

export async function getFileMentionSuggestions(sessionId: string, query: string): Promise<AutocompleteSuggestion[]> {
    // Remove the "@" prefix for searching
    const searchTerm = query.slice(1);

    try {
        // Use the file search cache with fuzzy matching
        const files = await searchFiles(sessionId, searchTerm, { limit: 5 });

        // Convert FileItem to suggestion format
        return files.map((file: FileItem) => ({
            key: `file-${file.fullPath}`,
            text: `@${file.fullPath}`,  // Full path in the mention
            component: () => React.createElement(FileMentionSuggestion, {
                fileName: file.fileName,
                filePath: file.filePath,
                fileType: file.fileType
            })
        }));
    } catch (error) {
        console.error('Error fetching file suggestions:', error);
        // Return empty array on error
        return [];
    }
}

function collectTaskMessageGroups(sessionId: string): TaskMessageGroup[] {
    const session = storage.getState().sessionMessages[sessionId];
    if (!session) return [];

    const groups: TaskMessageGroup[] = [];
    const seen = new Set<string>();
    const messages = [...session.messages].reverse();
    for (const message of messages) {
        let found: TaskMessageGroup[] = [];
        if (message.kind === 'agent-event' && message.event.type === 'options') {
            found = collectTaskMessageGroupsFromOptions(message.event.options);
        } else if (message.kind === 'agent-event' && message.event.type === 'message') {
            found = extractTaskMessageGroupsFromText(message.event.message);
        } else if (message.kind === 'agent-text') {
            found = extractTaskMessageGroupsFromText(message.text);
        }
        for (const group of found) {
            if (seen.has(group.messageId)) continue;
            seen.add(group.messageId);
            groups.push(group);
        }
    }
    return groups.reverse();
}

function normalizeTaskMessageQuery(query: string): { forceTaskMenu: boolean; searchTerm: string } {
    const searchTerm = query.slice(1).trim().toLowerCase();
    if (TASK_MESSAGE_ENTRY_TERMS.has(searchTerm)) {
        return { forceTaskMenu: true, searchTerm: '' };
    }
    return { forceTaskMenu: false, searchTerm };
}

function getTaskMessageSuggestions(sessionId: string, query: string): AutocompleteSuggestion[] {
    const { forceTaskMenu, searchTerm } = normalizeTaskMessageQuery(query);
    const groups = collectTaskMessageGroups(sessionId);
    const suggestions: AutocompleteSuggestion[] = [];

    for (const group of groups) {
        const { title, preview } = splitTaskMessageLabel(group.infoLabel);
        const searchable = `${title} ${preview} 已处理 确认 重复 忽略`.toLowerCase();
        if (searchTerm && !searchable.includes(searchTerm)) continue;

        suggestions.push({
            key: `task-message-${group.messageId}-info`,
            text: '',
            disabled: true,
            component: () => React.createElement(TaskMessageSuggestion, {
                title,
                description: preview,
                variant: 'info',
            }),
        });
        suggestions.push({
            key: `task-message-${group.messageId}-ack`,
            text: group.ackValue,
            submit: true,
            displayText: '已处理，确认',
            component: () => React.createElement(TaskMessageSuggestion, {
                title: '已处理，确认',
                description: title,
                variant: 'ack',
            }),
        });
        suggestions.push({
            key: `task-message-${group.messageId}-dismiss`,
            text: group.dismissValue,
            submit: true,
            displayText: '重复/不处理，忽略',
            component: () => React.createElement(TaskMessageSuggestion, {
                title: '重复/不处理，忽略',
                description: title,
                variant: 'dismiss',
            }),
        });
    }

    if (forceTaskMenu && suggestions.length === 0) {
        suggestions.push({
            key: 'task-message-empty',
            text: '',
            disabled: true,
            component: () => React.createElement(TaskMessageSuggestion, {
                title: '没有待处理任务消息',
                description: '当前会话没有 delivered 且未确认/忽略的任务消息',
                variant: 'info',
            }),
        });
    }

    return suggestions;
}

function getQuickBangSuggestions(query: string): AutocompleteSuggestion[] {
    const searchTerm = query.slice(1).trim().toLowerCase();
    const quick = [
        { command: '@u', description: '当前账号流量' },
        { command: '@a', description: '切换账号' },
        { command: '@reminder', description: '设置/取消提示' },
        { command: '@reply-monitor', description: '回复监控开关' },
    ];
    return quick
        .filter(item => !searchTerm || item.command.slice(1).includes(searchTerm) || item.description.toLowerCase().includes(searchTerm))
        .map(item => ({
            key: `bang-${item.command}`,
            text: item.command,
            submit: true,
            displayText: item.command,
            component: () => React.createElement(CommandSuggestion, {
                command: item.command,
                description: item.description,
            }),
        }));
}

export async function getSuggestions(sessionId: string, query: string): Promise<AutocompleteSuggestion[]> {
    console.log('💡 getSuggestions called with query:', JSON.stringify(query));

    if (!query || query.length === 0) {
        console.log('💡 getSuggestions: Empty query, returning empty array');
        return [];
    }

    // Check if it's a command (starts with /)
    if (query.startsWith('/')) {
        console.log('💡 getSuggestions: Command detected');
        const result = await getCommandSuggestions(sessionId, query);
        console.log('💡 getSuggestions: Command suggestions:', JSON.stringify(result.map(r => ({
            key: r.key,
            text: r.text,
            component: '[Function]'
        })), null, 2));
        return result;
    }

    // Check if it's a file mention (starts with @)
    if (query.startsWith('@')) {
        console.log('💡 getSuggestions: @ menu detected');
        const taskMessageQuery = normalizeTaskMessageQuery(query);
        if (taskMessageQuery.forceTaskMenu) {
            const taskResult = getTaskMessageSuggestions(sessionId, query);
            console.log('💡 getSuggestions: @task suggestions:', JSON.stringify(taskResult.map(r => ({
                key: r.key,
                text: r.text,
                disabled: r.disabled,
                submit: r.submit,
                component: '[Function]'
            })), null, 2));
            return taskResult;
        }
        const result = [
            ...getTaskMessageSuggestions(sessionId, query),
            ...getQuickBangSuggestions(query),
            ...await getFileMentionSuggestions(sessionId, query),
        ];
        console.log('💡 getSuggestions: @ suggestions:', JSON.stringify(result.map(r => ({
            key: r.key,
            text: r.text,
            disabled: r.disabled,
            submit: r.submit,
            component: '[Function]'
        })), null, 2));
        return result;
    }

    // No suggestions for other queries
    console.log('💡 getSuggestions: No matching prefix, returning empty array');
    return [];
}
