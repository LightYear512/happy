import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { logger } from '@/ui/logger';
import type { CodexModelModeConfig, CodexReasoningEffort } from './modelMode';
import { resolveCodexModelMode } from './modelMode';

const VALID_REASONING_EFFORTS = new Set<CodexReasoningEffort>([
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
]);

export function resolveCodexModelModeOrDefault(modelMode: string | null | undefined): CodexModelModeConfig {
    const explicit = resolveCodexModelMode(modelMode);
    if (explicit.model || explicit.reasoningEffort) {
        return explicit;
    }
    return readCodexDefaultModelConfig();
}

export function readCodexDefaultModelConfig(): CodexModelModeConfig {
    const codexHome = process.env.CODEX_HOME || join(os.homedir(), '.codex');
    const configPath = join(codexHome, 'config.toml');

    try {
        const rootConfig = readTomlRootTable(readFileSync(configPath, 'utf8'));
        const model = parseTomlRootString(rootConfig, 'model');
        const rawReasoningEffort = parseTomlRootString(rootConfig, 'model_reasoning_effort');
        const reasoningEffort = parseReasoningEffort(rawReasoningEffort);
        return {
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
        };
    } catch (error) {
        logger.debug(`[Codex] Failed to read default model config from ${configPath}:`, error);
        return {};
    }
}

function readTomlRootTable(contents: string): string {
    const firstSection = contents.search(/^\s*\[/m);
    return firstSection >= 0 ? contents.slice(0, firstSection) : contents;
}

function parseTomlRootString(rootTable: string, key: string): string | undefined {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = rootTable.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*(.+?)\\s*$`, 'm'));
    if (!match) return undefined;

    const rawValue = stripInlineComment(match[1]?.trim() ?? '').trim();
    if (!rawValue) return undefined;
    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
        try {
            return JSON.parse(rawValue) as string;
        } catch {
            return rawValue.slice(1, -1);
        }
    }
    if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
        return rawValue.slice(1, -1);
    }
    return rawValue;
}

function stripInlineComment(value: string): string {
    let inSingle = false;
    let inDouble = false;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\' && inDouble) {
            escaped = true;
            continue;
        }
        if (char === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }
        if (char === '"' && !inSingle) {
            inDouble = !inDouble;
            continue;
        }
        if (char === '#' && !inSingle && !inDouble) {
            return value.slice(0, index);
        }
    }
    return value;
}

function parseReasoningEffort(value: string | undefined): CodexReasoningEffort | undefined {
    if (!value) return undefined;
    if (VALID_REASONING_EFFORTS.has(value as CodexReasoningEffort)) {
        return value as CodexReasoningEffort;
    }
    logger.debug(`[Codex] Ignoring unsupported model_reasoning_effort from config.toml: ${value}`);
    return undefined;
}
