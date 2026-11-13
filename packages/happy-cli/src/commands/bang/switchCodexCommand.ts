/** Preserve the original global account selection, independently for GPT and DeepSeek. */
import { readCodexModelFamily } from '@/codex/defaultModelConfig';
import { buildCodexFamilyAccountMenu } from './authCommand';
import { publishAccountIntent } from './accountIntent';
import { readCodexProfiles } from './ccsProfiles';
import type { BangCommandContext, BangCommandResult, BangOptionSuggestion } from './types';

export const CODEX_SWITCH_OPTIONS: BangOptionSuggestion[] = [
    { label: '切换GPT账号', value: '!switch-codex gpt' },
    { label: '切换DeepSeek账号', value: '!switch-codex deepseek' },
];

export async function handleSwitchCodexCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const [family, profileName, extra] = args.trim().split(/\s+/).map(decodeURIComponent);
    if ((family !== 'gpt' && family !== 'deepseek') || extra !== undefined) {
        return { message: '请选择要切换的账号类型', action: 'none', suggestions: CODEX_SWITCH_OPTIONS };
    }
    const label = family === 'gpt' ? 'GPT' : 'DeepSeek';
    if (!profileName) {
        ctx.client.sendSessionEvent({ type: 'message', message: '⏳ 账号信息查询中' });
        return buildCodexFamilyAccountMenu(family, `!switch-codex ${family}`, `请选择要切换的 ${label} 账户：`);
    }
    const profile = readCodexProfiles().find(profile => profile.name === profileName
        && readCodexModelFamily(profile.codexHome) === family);
    if (!profile) {
        return { message: `所选账号不属于 ${label}，请重新选择。`, action: 'none', suggestions: CODEX_SWITCH_OPTIONS };
    }
    publishAccountIntent('codex', profile.name, Date.now(), undefined, family);
    return {
        message: [`✅ ${label} 全局账号已设置为 "${profile.name}"`,
            `现有 ${label} 会话不会被打断，将在下一次实际输入前核对并切换。`],
        action: 'none',
    };
}
