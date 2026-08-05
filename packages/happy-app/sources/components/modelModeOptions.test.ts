import { describe, expect, it } from 'vitest';
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

    it('builds codex model fallback from CLI settings plus GPT-5.6 test efforts', () => {
        const models = getCodexModelModes(translate);
        expect(models.map((model) => model.key)).toEqual([
            'default',
            'gpt-5.6-sol:minimal',
            'gpt-5.6-sol:low',
            'gpt-5.6-sol:medium',
            'gpt-5.6-sol:high',
        ]);
        expect(models[0].name).toBe('tr:agentInput.codexModel.default');
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

    it('ignores Codex metadata model cache and keeps the curated Codex choices', () => {
        const models = getAvailableModels('codex', {
            models: [
                { code: 'gpt-5.6', value: 'GPT 5.6', description: 'Unsupported cache entry' },
            ],
        } as any, translate);

        expect(models).toEqual([
            { key: 'default', name: 'tr:agentInput.codexModel.default', description: 'Use Codex CLI config' },
            { key: 'gpt-5.6-sol:minimal', name: 'tr:agentInput.codexModel.gpt5Minimal', description: 'gpt-5.6-sol / minimal reasoning' },
            { key: 'gpt-5.6-sol:low', name: 'tr:agentInput.codexModel.gpt5Low', description: 'gpt-5.6-sol / low reasoning' },
            { key: 'gpt-5.6-sol:medium', name: 'tr:agentInput.codexModel.gpt5Medium', description: 'gpt-5.6-sol / medium reasoning' },
            { key: 'gpt-5.6-sol:high', name: 'tr:agentInput.codexModel.gpt5High', description: 'gpt-5.6-sol / high reasoning' },
        ]);
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
