import { randomUUID } from 'node:crypto';
import type { Metadata } from '@/api/types';

export function createSessionTag(consoleSession: boolean, machineId: string): string {
    return consoleSession ? `happy-console:${machineId}` : randomUUID();
}

export function activateConsoleMetadata(
    current: Metadata,
    processMetadata: Metadata,
    now: number,
): Metadata {
    const { archivedBy: _archivedBy, archiveReason: _archiveReason, ...retained } = current;
    return {
        ...retained,
        ...processMetadata,
        lifecycleState: 'running',
        lifecycleStateSince: now,
    };
}
