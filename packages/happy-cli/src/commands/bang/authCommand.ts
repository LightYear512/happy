import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { readCcsProfiles, getCurrentCcsProfile, type CcsProfileInfo } from './ccsProfiles';
import { configuration } from '@/configuration';
import { centerText } from './format';
import { getCachedUsageSummary } from './usageCommand';
import { handleAuthCreateBangCommand } from './authCreateCommand';
import type { BangCommandContext, BangCommandResult } from './types';

/**
 * Handle the `!auth` bang command.
 *
 * - `!auth` — List available CCS profiles with current active indicator
 * - `!auth create <name>` — Create a new CCS profile via interactive login
 * - `!auth <name>` — Switch current session to the specified profile
 * - `!auth all <name>` — Switch all sessions on this machine to the specified profile
 */
export async function handleAuthBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const trimmed = args.trim();

    if (!trimmed) {
        return listProfiles();
    }

    // Route `!auth create <name>` to interactive login handler
    if (trimmed.toLowerCase() === 'create' || trimmed.toLowerCase().startsWith('create ')) {
        const createArgs = trimmed.slice(6).trim();
        return handleAuthCreateBangCommand(createArgs, ctx);
    }

    // Check for "all" prefix: !auth all [<profile>]
    if (trimmed.toLowerCase() === 'all' || trimmed.toLowerCase().startsWith('all ')) {
        const profileName = trimmed.slice(3).trim();
        if (!profileName) {
            return listProfiles();
        }
        return switchAllProfiles(profileName);
    }

    return switchProfile(trimmed);
}

/**
 * Attempt to switch to the profile specified in the global active-ccs-profile file.
 * Called by the fs.watch handler in claudeRemoteLauncher when the file changes.
 * Returns true if a switch occurred, false otherwise.
 */
export function tryGlobalProfileSwitch(): boolean {
    try {
        const filePath = configuration.activeProfileFile;
        if (!existsSync(filePath)) return false;

        const profileName = readFileSync(filePath, 'utf-8').trim();
        if (!profileName) return false;

        const currentProfile = getCurrentCcsProfile();
        if (profileName === currentProfile) return false;

        const { profiles } = readCcsProfiles();
        const target = profiles.find(p => p.name === profileName);
        if (!target) {
            logger.debug(`[!auth] Global switch: profile "${profileName}" not found`);
            return false;
        }

        const currentProfileInfo = currentProfile
            ? profiles.find(p => p.name === currentProfile) ?? null
            : null;
        if (!isSharedContext(currentProfileInfo, target)) {
            logger.debug(`[!auth] Global switch: "${profileName}" not in same context group, ignoring`);
            return false;
        }

        if (!existsSync(target.instancePath)) {
            logger.warn(`[!auth] Global switch: profile "${profileName}" instance not initialized (${target.instancePath}), skipping`);
            return false;
        }

        process.env.CLAUDE_CONFIG_DIR = target.instancePath;
        logger.debug(`[!auth] Global switch: switched CLAUDE_CONFIG_DIR to "${profileName}" (${target.instancePath})`);
        return true;
    } catch (err) {
        logger.debug('[!auth] Global profile switch error:', err);
        return false;
    }
}

/**
 * Check whether a profile's OAuth token is available and likely valid.
 * Returns a status indicator: '' (ok), '⚠' (no token / not initialized).
 */
function getProfileStatus(profile: CcsProfileInfo): string {
    if (!existsSync(profile.instancePath)) return '⚠';

    try {
        const credPath = join(profile.instancePath, '.credentials.json');
        const raw = readFileSync(credPath, 'utf-8');
        const data = JSON.parse(raw);
        if (!data.claudeAiOauth?.accessToken) return '⚠';
    } catch {
        return '⚠';
    }

    return '';
}

function listProfiles(): BangCommandResult {
    const { profiles } = readCcsProfiles();
    const currentProfile = getCurrentCcsProfile();
    const currentProfileInfo = currentProfile
        ? profiles.find(p => p.name === currentProfile) ?? null
        : null;

    const lines: string[] = [];

    // No active CCS profile (session not started via CCS)
    if (!currentProfile) {
        lines.push('📋 当前无 CCS 配置。');
        lines.push('');
        if (profiles.length > 0) {
            lines.push('可用配置:');
            for (const p of profiles) {
                const status = getProfileStatus(p);
                lines.push(status ? `○ ${p.name} ${status}` : `○ ${p.name}`);
            }
        } else {
            lines.push('未找到 CCS 配置。');
        }
        return { message: centerText(lines), action: 'none' };
    }

    const isShared = currentProfileInfo?.contextMode === 'shared';
    const currentGroup = isShared ? (currentProfileInfo.contextGroup || 'default') : null;

    // Find other profiles in the same shared group
    const switchable = currentGroup
        ? profiles.filter(p =>
            p.contextMode === 'shared'
            && (p.contextGroup || 'default') === currentGroup
            && p.name !== currentProfile)
        : [];

    if (currentGroup) {
        lines.push(`📋 组 "${currentGroup}"`);
    } else {
        lines.push(`📋 ${currentProfile} (独立)`);
    }

    lines.push('');
    const currentStatus = currentProfileInfo ? getProfileStatus(currentProfileInfo) : '';
    lines.push(currentStatus ? `● ${currentProfile} ${currentStatus}` : `● ${currentProfile}`);

    if (currentGroup && switchable.length > 0) {
        for (const profile of switchable) {
            const status = getProfileStatus(profile);
            lines.push(status ? `○ ${profile.name} ${status}` : `○ ${profile.name}`);
        }
        lines.push('');
        lines.push('!auth <名称> · 当前会话');
        lines.push('!auth all <名称> · 全部会话');
    } else if (currentGroup) {
        lines.push('');
        lines.push('本组无其他账号。');
    } else {
        lines.push('');
        lines.push('无法切换。');
    }

    return { message: centerText(lines), action: 'none' };
}

/**
 * Check whether two profiles share the same context (both shared mode, same group).
 * When context is shared, switching profiles should NOT reset the session.
 */
function isSharedContext(
    source: CcsProfileInfo | null,
    target: CcsProfileInfo,
): boolean {
    if (!source) return false;
    if (source.contextMode !== 'shared' || target.contextMode !== 'shared') return false;
    const sourceGroup = source.contextGroup || 'default';
    const targetGroup = target.contextGroup || 'default';
    return sourceGroup === targetGroup;
}

function switchProfile(profileName: string): BangCommandResult {
    const { profiles } = readCcsProfiles();
    const currentProfile = getCurrentCcsProfile();

    // Find the target profile
    const target = profiles.find(p => p.name === profileName);

    if (!target) {
        const lines = [
            `❌ 未找到配置 "${profileName}"。`,
            '',
            '使用 !auth 查看可用账号。',
        ];
        return { message: centerText(lines), action: 'none' };
    }

    // Check if already on this profile
    if (target.name === currentProfile) {
        return { message: centerText([`✅ 当前已是 "${profileName}"`]), action: 'none' };
    }

    // Only allow switching within the same shared context group
    const currentProfileInfo = currentProfile
        ? profiles.find(p => p.name === currentProfile) ?? null
        : null;

    if (!isSharedContext(currentProfileInfo, target)) {
        const describeMode = (p: CcsProfileInfo | null): string =>
            !p || p.contextMode !== 'shared' ? '独立' : `组 "${p.contextGroup || 'default'}"`;
        const lines = [
            '❌ 无法切换',
            '',
            `"${currentProfile || 'unknown'}" → ${describeMode(currentProfileInfo)}`,
            `"${profileName}" → ${describeMode(target)}`,
        ];
        return { message: centerText(lines), action: 'none' };
    }

    // Verify instance directory exists
    if (!existsSync(target.instancePath)) {
        return { message: centerText([`❌ 配置 "${profileName}" 未初始化。`]), action: 'none' };
    }

    // Perform the switch — shared context, no session reset needed
    process.env.CLAUDE_CONFIG_DIR = target.instancePath;
    logger.debug(`[!auth] Switched CLAUDE_CONFIG_DIR to: ${target.instancePath}`);

    const usageLine = getCachedUsageSummary(target.instancePath);
    const lines = [`✅ 已切换到 "${profileName}"`];
    if (usageLine) {
        lines.push('', usageLine);
    }
    return { message: centerText(lines), action: 'restart-session' };
}

/**
 * Switch all sessions on this machine to the specified profile.
 * Validates and switches the current session, then writes the profile name
 * to a global file so other sessions pick it up via fs.watch.
 */
function switchAllProfiles(profileName: string): BangCommandResult {
    const { profiles } = readCcsProfiles();
    const currentProfile = getCurrentCcsProfile();
    const target = profiles.find(p => p.name === profileName);

    if (!target) {
        const lines = [
            `❌ 未找到配置 "${profileName}"。`,
            '',
            '使用 !auth 查看可用账号。',
        ];
        return { message: centerText(lines), action: 'none' };
    }

    const currentProfileInfo = currentProfile
        ? profiles.find(p => p.name === currentProfile) ?? null
        : null;

    if (!isSharedContext(currentProfileInfo, target)) {
        const describeMode = (p: CcsProfileInfo | null): string =>
            !p || p.contextMode !== 'shared' ? '独立' : `组 "${p.contextGroup || 'default'}"`;
        const lines = [
            '❌ 无法切换',
            '',
            `"${currentProfile || 'unknown'}" → ${describeMode(currentProfileInfo)}`,
            `"${profileName}" → ${describeMode(target)}`,
        ];
        return { message: centerText(lines), action: 'none' };
    }

    if (!existsSync(target.instancePath)) {
        return { message: centerText([`❌ 配置 "${profileName}" 未初始化。`]), action: 'none' };
    }

    const alreadyCurrent = target.name === currentProfile;
    const groupName = currentProfileInfo?.contextGroup || 'default';

    // Switch current session (skip if already on target)
    if (!alreadyCurrent) {
        process.env.CLAUDE_CONFIG_DIR = target.instancePath;
        logger.debug(`[!auth] Switched CLAUDE_CONFIG_DIR to: ${target.instancePath}`);
    }

    // Always write global file so other sessions pick up the change
    try {
        writeFileSync(configuration.activeProfileFile, profileName, 'utf-8');
        logger.debug(`[!auth] Wrote global active profile: ${profileName}`);
    } catch (err) {
        logger.debug('[!auth] Failed to write global profile file:', err);
        if (alreadyCurrent) {
            const lines = [
                `✅ 当前已是 "${profileName}"`,
                '',
                '广播到其他会话失败。',
            ];
            return { message: centerText(lines), action: 'none' };
        }
        const lines = [
            `⚠️ 已在本地切换到 "${profileName}"`,
            '',
            '广播到其他会话失败。',
        ];
        return { message: centerText(lines), action: 'restart-session' };
    }

    const usageLine = getCachedUsageSummary(target.instancePath);

    if (alreadyCurrent) {
        const lines = [
            `✅ 当前已是 "${profileName}"`,
            '',
            `已广播到组 "${groupName}"`,
        ];
        if (usageLine) lines.push('', usageLine);
        return { message: centerText(lines), action: 'none' };
    }

    const lines = [
        `✅ 已切换到 "${profileName}"`,
        '',
        `组 "${groupName}" 中的所有会话`,
    ];
    if (usageLine) lines.push('', usageLine);
    return { message: centerText(lines), action: 'restart-session' };
}
