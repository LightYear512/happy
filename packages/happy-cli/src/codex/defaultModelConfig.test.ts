import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readCodexDefaultModelConfig, resolveCodexModelModeOrDefault } from './defaultModelConfig';

const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;
const TEMP_DIRS: string[] = [];

afterEach(() => {
    if (ORIGINAL_CODEX_HOME === undefined) {
        delete process.env.CODEX_HOME;
    } else {
        process.env.CODEX_HOME = ORIGINAL_CODEX_HOME;
    }
    while (TEMP_DIRS.length > 0) {
        const dir = TEMP_DIRS.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

describe('readCodexDefaultModelConfig', () => {
    it('reads the active CODEX_HOME config model and reasoning effort', () => {
        const codexHome = createCodexHome(`
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"

[projects."/tmp"]
trust_level = "trusted"
`);

        process.env.CODEX_HOME = codexHome;

        expect(readCodexDefaultModelConfig()).toEqual({
            model: 'gpt-5.6-sol',
            reasoningEffort: 'xhigh',
        });
    });

    it('uses supported reasoning effort values from config', () => {
        const codexHome = createCodexHome(`
model = "gpt-5.6-sol" # inline comments are ignored
model_reasoning_effort = "high"
`);

        process.env.CODEX_HOME = codexHome;

        expect(readCodexDefaultModelConfig()).toEqual({
            model: 'gpt-5.6-sol',
            reasoningEffort: 'high',
        });
    });

    it('lets an explicit Happy model selection override the default config', () => {
        const codexHome = createCodexHome(`
model = "gpt-5.5"
model_reasoning_effort = "high"
`);

        process.env.CODEX_HOME = codexHome;

        expect(resolveCodexModelModeOrDefault('gpt-5.6-sol:low')).toEqual({
            model: 'gpt-5.6-sol',
            reasoningEffort: 'low',
        });
    });
});

function createCodexHome(config: string): string {
    const dir = mkdtempSync(join(os.tmpdir(), 'happy-codex-config-'));
    TEMP_DIRS.push(dir);
    writeFileSync(join(dir, 'config.toml'), config.trimStart());
    return dir;
}
