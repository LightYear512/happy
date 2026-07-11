export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type CodexModelModeConfig = {
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
};

export const CODEX_GPT56_MODEL = 'gpt-5.6-sol';
export const CODEX_MODEL_MODE_OPTIONS = [
    { code: 'default', value: '使用 CLI 设置', description: 'Use Codex CLI config' },
    { code: 'gpt-5.6-sol:minimal', value: 'GPT-5.6 极简', description: 'gpt-5.6-sol / minimal reasoning' },
    { code: 'gpt-5.6-sol:low', value: 'GPT-5.6 低', description: 'gpt-5.6-sol / low reasoning' },
    { code: 'gpt-5.6-sol:medium', value: 'GPT-5.6 中', description: 'gpt-5.6-sol / medium reasoning' },
    { code: 'gpt-5.6-sol:high', value: 'GPT-5.6 高', description: 'gpt-5.6-sol / high reasoning' },
] as const;

type CodexModelMetadata = {
    models?: Array<{ code: string; value: string; description?: string | null }>;
    currentModelCode?: string;
};

export function withCodexModelModeMetadata<T extends CodexModelMetadata>(metadata: T): T {
    return {
        ...metadata,
        models: CODEX_MODEL_MODE_OPTIONS.map((option) => ({ ...option })),
        currentModelCode: metadata.currentModelCode && metadata.currentModelCode !== 'gpt-5-codex-high'
            ? metadata.currentModelCode
            : 'default',
    };
}

const GPT56_EFFORT_BY_MODE = new Map<string, CodexReasoningEffort>([
    ['gpt-5.6-sol:minimal', 'minimal'],
    ['gpt-5.6-sol:low', 'low'],
    ['gpt-5.6-sol:medium', 'medium'],
    ['gpt-5.6-sol:high', 'high'],
    // Backward-compatible aliases for sessions that cached the previous keys.
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
]);

export function resolveCodexModelMode(modelMode: string | null | undefined): CodexModelModeConfig {
    if (!modelMode || modelMode === 'default') {
        return {};
    }

    const effort = GPT56_EFFORT_BY_MODE.get(modelMode);
    if (effort) {
        return { model: CODEX_GPT56_MODEL, reasoningEffort: effort };
    }

    return { model: modelMode };
}
