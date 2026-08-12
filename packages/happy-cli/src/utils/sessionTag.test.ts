import { describe, expect, it } from 'vitest';
import { activateConsoleMetadata, createSessionTag } from './sessionTag';

describe('createSessionTag', () => {
    it('reuses one machine-scoped console identity across restarts', () => {
        expect(createSessionTag(true, 'machine-1')).toBe('happy-console:machine-1');
        expect(createSessionTag(true, 'machine-1')).toBe('happy-console:machine-1');
    });

    it('keeps ordinary sessions unique', () => {
        expect(createSessionTag(false, 'machine-1')).not.toBe(createSessionTag(false, 'machine-1'));
    });

    it('reopens an archived console without losing its stable presentation', () => {
        const current = {
            path: '/old', host: 'host', version: '1', os: 'darwin', machineId: 'machine-1',
            homeDir: '/home', happyHomeDir: '/home/.happy', happyLibDir: '/old/lib',
            happyToolsDir: '/old/tools', startedFromDaemon: true, hostPid: 10,
            startedBy: 'daemon' as const, consoleSession: true, lifecycleState: 'archived' as const,
            lifecycleStateSince: 1, archivedBy: 'cli', archiveReason: 'User terminated',
            summary: { text: 'happy 控制台', updatedAt: 2 },
        };
        const processMetadata = { ...current, hostPid: 20, happyLibDir: '/new/lib',
            happyToolsDir: '/new/tools', lifecycleState: 'running' as const,
            lifecycleStateSince: 3 };

        expect(activateConsoleMetadata(current, processMetadata, 4)).toEqual({
            ...processMetadata,
            lifecycleState: 'running',
            lifecycleStateSince: 4,
        });
    });
});
