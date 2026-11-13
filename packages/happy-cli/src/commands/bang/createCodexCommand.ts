/** Create a provider-bound Codex session through the existing daemon and options UI. */
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readCodexModelFamily } from '@/codex/defaultModelConfig';
import { spawnDaemonSession } from '@/daemon/controlClient';
import { getHappyHome, readCodexDefaultProfile, readCodexProfiles } from './ccsProfiles';
import { buildCodexFamilyAccountMenu } from './authCommand';
import { readAccountIntent } from './accountIntent';
import type { BangCommandContext, BangCommandResult, BangOptionSuggestion } from './types';

export const CODEX_CREATE_OPTIONS: BangOptionSuggestion[] = [
    { label: '创建codex+GPT会话', value: '!create-codex gpt' },
    { label: '创建codex+DeepSeek会话', value: '!create-codex deepseek' },
];

/** Current restore records supply recent directories; never scan conversation history. */
async function recentDirectories(): Promise<string[]> {
    const restore = join(getHappyHome(), 'restore');
    const directories = new Set<string>();
    const files = await readdir(restore).catch(() => [] as string[]);
    const records = await Promise.all(files.filter(file => file.endsWith('.json')).map(async file => {
        try {
            const path = join(restore, file);
            const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
            const record: unknown = JSON.parse(raw);
            return { record, time: info.mtimeMs };
        } catch { return { record: null, time: 0 }; }
    }));
    for (const { record } of records.sort((a, b) => b.time - a.time)) {
        const directory = (record as { directory?: unknown } | null)?.directory;
        if (typeof directory !== 'string' || !isAbsolute(directory)
            || directory.includes('/xc-disposable/') || directory === join(getHappyHome(), 'console')) continue;
        if ((await stat(directory).catch(() => null))?.isDirectory()) directories.add(directory);
        if (directories.size === 12) break;
    }
    directories.add(homedir());
    return [...directories];
}

export async function handleCreateCodexCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const parts = args.trim().split(/\s+/).filter(Boolean).map(decodeURIComponent);
    const [provider, requestedProfile, directory] = parts;
    if (!['gpt', 'deepseek'].includes(provider) || parts.length > 3) {
        return { message: '请选择要创建的会话', action: 'none', suggestions: CODEX_CREATE_OPTIONS };
    }
    const title = provider === 'gpt' ? 'Codex + GPT' : 'Codex + DeepSeek';
    const profiles = readCodexProfiles().filter(profile => readCodexModelFamily(profile.codexHome) === provider);
    if (!profiles.length) return { message: `未找到可用的 ${title} 账号，请先在本机配置账号。`, action: 'none' };
    const defaultProfile = readAccountIntent('codex', undefined, provider as 'gpt' | 'deepseek')?.profileName ?? readCodexDefaultProfile();
    profiles.sort((a, b) => Number(b.name === defaultProfile) - Number(a.name === defaultProfile) || a.name.localeCompare(b.name));
    if (!requestedProfile && profiles.length > 1) {
        return buildCodexFamilyAccountMenu(provider as 'gpt' | 'deepseek',
            `!create-codex ${provider}`, `请选择 ${title} 账号`);
    }
    const profile = requestedProfile ? profiles.find(p => p.name === requestedProfile) : profiles[0];
    if (!profile) return { message: '所选账号不属于此模型类型，请重新选择。', action: 'none', suggestions: CODEX_CREATE_OPTIONS };
    if (!directory) {
        return {
            message: `${title} · ${profile.name}\n请选择工作目录`, action: 'none',
            suggestions: (await recentDirectories()).map(path => ({ label: path,
                value: `!create-codex ${provider} ${encodeURIComponent(profile.name)} ${encodeURIComponent(path)}` })),
        };
    }
    if (!isAbsolute(directory) || !(await stat(directory).catch(() => null))?.isDirectory()) {
        return { message: '工作目录不存在，请重新选择。', action: 'none',
            suggestions: [{ label: '选择工作目录', value: `!create-codex ${provider} ${encodeURIComponent(profile.name)}` }] };
    }
    ctx.client.sendSessionEvent({ type: 'message', message: `正在创建 ${title}…` });
    const result = await spawnDaemonSession(resolve(directory), undefined, undefined,
        title, 'codex', profile.name);
    if (!result.success || !result.sessionId) {
        return { message: `创建失败：${result.error || '未收到新会话就绪回执'}`, action: 'none' };
    }
    return { message: [`已创建 ${title} · ${profile.name}`, `目录：${directory}`, '新会话已出现在 App 会话列表中。'], action: 'none' };
}
