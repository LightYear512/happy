import { describe, expect, it } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import { createSessionMetadata, HAPPY_CONSOLE_TITLE } from './createSessionMetadata';

function createSandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return {
        enabled: true,
        workspaceRoot: '~/Developer',
        sessionIsolation: 'workspace',
        customWritePaths: [],
        denyReadPaths: ['~/.ssh', '~/.aws', '~/.gnupg'],
        extraWritePaths: ['/tmp'],
        denyWritePaths: ['.env'],
        networkMode: 'allowed',
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
        ...overrides,
    };
}

describe('createSessionMetadata', () => {
    it('defines the exact stable console title', () => {
        expect(HAPPY_CONSOLE_TITLE).toBe('happy 控制台');
    });

    it('sets metadata.sandbox to the config when enabled', () => {
        const sandbox = createSandboxConfig();
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-1',
            startedBy: 'terminal',
            sandbox,
        });

        expect(metadata.sandbox).toEqual(sandbox);
    });

    it('sets metadata.sandbox to null when sandbox is disabled', () => {
        const sandbox = createSandboxConfig({ enabled: false });
        const { metadata } = createSessionMetadata({
            flavor: 'gemini',
            machineId: 'machine-2',
            startedBy: 'daemon',
            sandbox,
        });

        expect(metadata.sandbox).toBeNull();
    });

    it('sets metadata.sandbox to null when sandbox is not provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-3',
        });

        expect(metadata.sandbox).toBeNull();
    });

    it('sets metadata.dangerouslySkipPermissions to null when not provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-4',
        });

        expect(metadata.dangerouslySkipPermissions).toBeNull();
    });

    it('sets metadata.dangerouslySkipPermissions when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-5',
            dangerouslySkipPermissions: true,
        });

        expect(metadata.dangerouslySkipPermissions).toBe(true);
    });

    it('persists the initial permission mode for exact restore', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-permission',
            permissionMode: 'bypassPermissions',
        });

        expect(metadata.permissionMode).toBe('bypassPermissions');
    });

    it('marks daemon console sessions explicitly', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-console',
            consoleSession: true,
        });

        expect(metadata.consoleSession).toBe(true);
        expect(metadata.name).toBe('happy 控制台');
    });

    it('seeds a stable Happy name independently from the mutable summary', () => {
        const { metadata } = createSessionMetadata({ flavor: 'codex', machineId: 'machine-name' });
        expect(metadata.name).toBeTruthy();
        expect(metadata.summary).toBeUndefined();
    });

    it('persists external title authority while leaving model authority backward compatible', () => {
        const managed = createSessionMetadata({ flavor: 'codex', machineId: 'managed', titleAuthority: 'external' });
        const normal = createSessionMetadata({ flavor: 'codex', machineId: 'normal', titleAuthority: 'model' });
        expect(managed.metadata.titleAuthority).toBe('external');
        expect(normal.metadata.titleAuthority).toBeUndefined();
    });

    it('adds Codex model metadata for old clients that read session metadata options', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-6',
        });

        expect(metadata.currentModelCode).toBe('default');
        expect(metadata.models?.map((model) => model.code)).toEqual([
            'default',
            'gpt-5.6-sol:minimal',
            'gpt-5.6-sol:low',
            'gpt-5.6-sol:medium',
            'gpt-5.6-sol:high',
        ]);
    });

    it('does not add Codex model metadata to non-Codex sessions', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-7',
        });

        expect(metadata.currentModelCode).toBeUndefined();
        expect(metadata.models).toBeUndefined();
    });
});
