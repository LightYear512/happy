import { describe, expect, it } from 'vitest';
import { resolveCodexModelMode, withCodexModelModeMetadata } from './modelMode';

describe('resolveCodexModelMode', () => {
    it('leaves default and empty modes under Codex CLI config control', () => {
        expect(resolveCodexModelMode(null)).toEqual({});
        expect(resolveCodexModelMode(undefined)).toEqual({});
        expect(resolveCodexModelMode('default')).toEqual({});
    });

    it.each([
        ['gpt-5.6-sol:minimal', 'minimal'],
        ['gpt-5.6-sol:low', 'low'],
        ['gpt-5.6-sol:medium', 'medium'],
        ['gpt-5.6-sol:high', 'high'],
    ] as const)('maps %s to gpt-5.6-sol with %s reasoning effort', (mode, effort) => {
        expect(resolveCodexModelMode(mode)).toEqual({
            model: 'gpt-5.6-sol',
            reasoningEffort: effort,
        });
    });

    it.each([
        ['gpt-5:minimal', 'minimal'],
        ['gpt-5:low', 'low'],
        ['gpt-5:medium', 'medium'],
        ['gpt-5:high', 'high'],
        ['gpt-5-minimal', 'minimal'],
        ['gpt-5-low', 'low'],
        ['gpt-5-medium', 'medium'],
        ['gpt-5-high', 'high'],
        ['gpt-5-codex-low', 'low'],
        ['gpt-5-codex-medium', 'medium'],
        ['gpt-5-codex-high', 'high'],
    ] as const)('keeps previous %s key as a gpt-5.6-sol alias', (mode, effort) => {
        expect(resolveCodexModelMode(mode)).toEqual({
            model: 'gpt-5.6-sol',
            reasoningEffort: effort,
        });
    });

    it('passes unknown explicit model slugs through for manual testing', () => {
        expect(resolveCodexModelMode('gpt-5.6')).toEqual({
            model: 'gpt-5.6',
        });
    });

    it('adds model metadata for old app bundles', () => {
        expect(withCodexModelModeMetadata({ path: '/tmp', currentModelCode: 'gpt-5-codex-high' })).toEqual({
            path: '/tmp',
            currentModelCode: 'default',
            models: [
                { code: 'default', value: '使用 CLI 设置', description: 'Use Codex CLI config' },
                { code: 'gpt-5.6-sol:minimal', value: 'GPT-5.6 极简', description: 'gpt-5.6-sol / minimal reasoning' },
                { code: 'gpt-5.6-sol:low', value: 'GPT-5.6 低', description: 'gpt-5.6-sol / low reasoning' },
                { code: 'gpt-5.6-sol:medium', value: 'GPT-5.6 中', description: 'gpt-5.6-sol / medium reasoning' },
                { code: 'gpt-5.6-sol:high', value: 'GPT-5.6 高', description: 'gpt-5.6-sol / high reasoning' },
            ],
        });
    });
});
