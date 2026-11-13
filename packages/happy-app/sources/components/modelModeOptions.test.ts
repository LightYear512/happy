import { describe, expect, it } from 'vitest';
import { CODEX_MODEL_MODE_OPTIONS, resolveCodexModelMode, withCodexModelModeMetadata } from '../../../happy-cli/src/codex/modelMode';
import type { Metadata } from '@/sync/storageTypes';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getCodexModelModes,
    getClaudePermissionModes,
    mapMetadataOptions,
    resolveCurrentOption,
} from './modelModeOptions';

const translate = (key: string) => `tr:${key}`;

describe('modelModeOptions', () => {
    it('maps metadata option shape into mode options', () => {
        expect(mapMetadataOptions([
            { code: 'm1', value: 'Model One', description: 'Primary model' },
            { code: 'm2', value: 'Model Two' },
        ])).toEqual([
            { key: 'm1', name: 'Model One', description: 'Primary model' },
            { key: 'm2', name: 'Model Two', description: null },
        ]);
    });

    it('builds claude permission fallbacks with translated names', () => {
        const modes = getClaudePermissionModes(translate);
        expect(modes.map((mode) => mode.key)).toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
        expect(modes[0].name).toBe('tr:agentInput.permissionMode.default');
    });

    it('offers CLI defaults, GPT-6 Astra and GPT-5.6 effort choices', () => {
        const models = getCodexModelModes(translate);
        expect(models.map((model) => model.key)).toEqual([
            'default',
            'gpt-6-astra:low',
            'gpt-6-astra:medium',
            'gpt-6-astra:high',
            'gpt-6-astra:xhigh',
            'gpt-5.6-sol:minimal',
            'gpt-5.6-sol:low',
            'gpt-5.6-sol:medium',
            'gpt-5.6-sol:high',
        ]);
        expect(models[0].name).toBe('tr:agentInput.codexModel.default');
    });

    it('keeps frontend choices executable by the CLI model resolver', () => {
        const modes = getCodexModelModes(translate);
        expect(modes.map((mode) => mode.key)).toEqual(CODEX_MODEL_MODE_OPTIONS.map((mode) => mode.code));
        expect(resolveCodexModelMode(modes.find((mode) => mode.key === 'gpt-6-astra:high')!.key)).toEqual({
            model: 'gpt-6-astra', reasoningEffort: 'high',
        });
        expect(resolveCodexModelMode(modes[0].key)).toEqual({});
    });

    it('prefers metadata models over hardcoded fallbacks', () => {
        const models = getAvailableModels('gemini', {
            models: [
                { code: 'custom-gemini', value: 'Gemini Custom', description: 'From metadata' },
            ],
        } as any, translate);

        expect(models).toEqual([
            { key: 'custom-gemini', name: 'Gemini Custom', description: 'From metadata' },
        ]);
    });

    it('uses Codex metadata keys, labels and order without substituting fixed choices', () => {
        const models = getAvailableModels('codex', {
            models: [
                { code: 'default', value: 'CLI configuration', description: 'From CLI' },
                { code: 'gpt-6-astra:high', value: 'GPT-6 Astra high', description: 'Configured high effort' },
            ],
        } as Metadata, translate);

        expect(models).toEqual([
            { key: 'default', name: 'CLI configuration', description: 'From CLI' },
            { key: 'gpt-6-astra:high', name: 'GPT-6 Astra high', description: 'Configured high effort' },
        ]);
    });

    it.each([undefined, null, {}, { models: [] }])('keeps existing Codex choices when metadata has no models: %j', (metadata) => {
        expect(getAvailableModels('codex', metadata as Metadata | null | undefined, translate))
            .toEqual(getCodexModelModes(translate));
    });

    it('shows refreshed labels for the same Codex model key', () => {
        const before = getAvailableModels('codex', {
            models: [{ code: 'default', value: 'Use CLI settings' }],
        } as Metadata, translate);
        const after = getAvailableModels('codex', {
            models: [{ code: 'default', value: 'Use CLI settings: GPT-6 Astra / high' }],
        } as Metadata, translate);

        expect(before[0].name).toBe('Use CLI settings');
        expect(resolveCurrentOption(after, ['default'])?.name).toBe('Use CLI settings: GPT-6 Astra / high');
    });

    it('renders restored CLI metadata and resolves the selected Astra high choice', () => {
        const restored = withCodexModelModeMetadata({
            path: '/tmp', currentModelCode: 'gpt-6-astra:high',
            models: [{ code: 'gpt-5-high', value: 'GPT-5 high' }],
        });
        const received = JSON.parse(JSON.stringify(restored)) as Metadata;
        const models = getAvailableModels('codex', received, translate);
        expect(models).toEqual(mapMetadataOptions(restored.models));
        const selected = resolveCurrentOption(models, [received.currentModelCode, 'default']);
        expect(selected?.name).toBe('GPT-6 Astra 高');
        expect(resolveCodexModelMode(selected?.key)).toEqual({ model: 'gpt-6-astra', reasoningEffort: 'high' });
    });

    it('keeps codex permission modes hardcoded even when metadata modes exist', () => {
        const modes = getAvailablePermissionModes('codex', {
            operatingModes: [{ code: 'metadata-only', value: 'Metadata Mode', description: null }],
        } as any, translate);

        expect(modes.map((mode) => mode.key)).toEqual(['default', 'read-only', 'safe-yolo', 'yolo']);
    });

    it('applies hacks to metadata-provided operating modes', () => {
        const modes = getAvailablePermissionModes('gemini', {
            operatingModes: [
                { code: 'build', value: 'build, build', description: 'Do build steps' },
                { code: 'plan', value: 'plan/plan', description: 'Plan first' },
            ],
        } as any, translate);

        expect(modes).toEqual([
            { key: 'build', name: 'Build', description: 'Do build steps' },
            { key: 'plan', name: 'Plan', description: 'Plan first' },
        ]);
    });

    it('resolves the first matching preferred key', () => {
        const options = [
            { key: 'a', name: 'A' },
            { key: 'b', name: 'B' },
        ];

        expect(resolveCurrentOption(options, ['missing', 'b', 'a'])).toEqual({ key: 'b', name: 'B' });
        expect(resolveCurrentOption(options, ['missing'])).toBeNull();
    });
});
