import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { readCcsProfiles, getCurrentCcsProfile, type CcsProfileInfo } from './ccsProfiles';
import { configuration } from '@/configuration';
import { getCachedUsageSummary } from './usageCommand';
import { SEPARATOR, type BangCommandContext, type BangCommandResult } from './types';

/**
 * Handle the `!auth` bang command.
 *
 * In normal sessions:
 * - `!auth` — List available CCS profiles with current active indicator
 * - `!auth <name>` — Switch current session to the specified profile
 *
 * In console:
 * - `!auth` — List available CCS profiles
 * - `!auth all <name>` — Switch all sessions on this machine to the specified profile
 */
export async function handleAuthBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const trimmed = args.trim();

    if (!trimmed) {
        return listProfiles(!!ctx.isConsoleSession);
    }

    // Check for "all" prefix: !auth all [<profile>]
    if (trimmed.toLowerCase() === 'all' || trimmed.toLowerCase().startsWith('all ')) {
        if (!ctx.isConsoleSession) {
            return {
                message: ['❌ !auth all 仅在控制台中可用'],
                action: 'none',
            };
        }
        const profileName = trimmed.slice(3).trim();
        if (!profileName) {
            return listProfiles(true);
        }
        return switchAllProfiles(profileName);
    }

    if (ctx.isConsoleSession) {
        return {
            message: ['❌ 控制台中请使用 !auth all <name> 切换所有会话'],
            action: 'none',
        };
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

function listProfiles(isConsole: boolean): BangCommandResult {
    const { profiles } = readCcsProfiles();
    const currentProfile = getCurrentCcsProfile();
    const currentProfileInfo = currentProfile
        ? profiles.find(p => p.name === currentProfile) ?? null
        : null;

    // No active CCS profile (session not started via CCS)
    if (!currentProfile) {
        const messages: string[] = ['📋 当前无 CCS 配置。'];
        if (profiles.length > 0) {
            messages.push(SEPARATOR);
            for (const p of profiles) {
                const status = getProfileStatus(p);
                messages.push(status ? `○ ${p.name} ${status}` : `○ ${p.name}`);
            }
            messages.push(SEPARATOR);
        } else {
            messages.push('未找到 CCS 配置。');
        }
        return { message: messages, action: 'none' };
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

    const messages: string[] = [];

    if (currentGroup) {
        messages.push(`📋 组 "${currentGroup}"`);
    } else {
        messages.push(`📋 ${currentProfile} (独立)`);
    }

    const currentStatus = currentProfileInfo ? getProfileStatus(currentProfileInfo) : '';

    messages.push(SEPARATOR);
    messages.push(currentStatus ? `● ${currentProfile} ${currentStatus}` : `● ${currentProfile}`);

    if (currentGroup && switchable.length > 0) {
        for (const profile of switchable) {
            const status = getProfileStatus(profile);
            messages.push(status ? `○ ${profile.name} ${status}` : `○ ${profile.name}`);
        }
        messages.push(SEPARATOR);
        messages.push(isConsole
            ? '!auth all <名称> → 切换全部会话'
            : '!auth <名称> → 切换当前会话');
    } else if (currentGroup) {
        messages.push(SEPARATOR);
        messages.push('本组无其他账号。');
    } else {
        messages.push(SEPARATOR);
        messages.push('无法切换。');
    }

    return { message: messages, action: 'none' };
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
        return {
            message: [`❌ 未找到配置 "${profileName}"。`, '使用 !auth 查看可用账号。'],
            action: 'none',
        };
    }

    // Check if already on this profile
    if (target.name === currentProfile) {
        return { message: `✅ 当前已是 "${profileName}"`, action: 'none' };
    }

    // Only allow switching within the same shared context group
    const currentProfileInfo = currentProfile
        ? profiles.find(p => p.name === currentProfile) ?? null
        : null;

    if (!isSharedContext(currentProfileInfo, target)) {
        const describeMode = (p: CcsProfileInfo | null): string =>
            !p || p.contextMode !== 'shared' ? '独立' : `组 "${p.contextGroup || 'default'}"`;
        return {
            message: [
                '❌ 无法切换',
                `"${currentProfile || 'unknown'}" → ${describeMode(currentProfileInfo)}`,
                `"${profileName}" → ${describeMode(target)}`,
            ],
            action: 'none',
        };
    }

    // Verify instance directory exists
    if (!existsSync(target.instancePath)) {
        return { message: `❌ 配置 "${profileName}" 未初始化。`, action: 'none' };
    }

    // Perform the switch — shared context, no session reset needed
    process.env.CLAUDE_CONFIG_DIR = target.instancePath;
    logger.debug(`[!auth] Switched CLAUDE_CONFIG_DIR to: ${target.instancePath}`);

    const usageLine = getCachedUsageSummary(target.instancePath);
    const messages = [`✅ 已切换到 "${profileName}"`];
    if (usageLine) messages.push(usageLine);
    return { message: messages, action: 'restart-session' };
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
        return {
            message: [`❌ 未找到配置 "${profileName}"。`, '使用 !auth 查看可用账号。'],
            action: 'none',
        };
    }

    const currentProfileInfo = currentProfile
        ? profiles.find(p => p.name === currentProfile) ?? null
        : null;

    if (!isSharedContext(currentProfileInfo, target)) {
        const describeMode = (p: CcsProfileInfo | null): string =>
            !p || p.contextMode !== 'shared' ? '独立' : `组 "${p.contextGroup || 'default'}"`;
        return {
            message: [
                '❌ 无法切换',
                `"${currentProfile || 'unknown'}" → ${describeMode(currentProfileInfo)}`,
                `"${profileName}" → ${describeMode(target)}`,
            ],
            action: 'none',
        };
    }

    if (!existsSync(target.instancePath)) {
        return { message: `❌ 配置 "${profileName}" 未初始化。`, action: 'none' };
    }

    const groupName = currentProfileInfo?.contextGroup || 'default';

    // Write global file so other sessions pick up the change via fs.watch
    try {
        writeFileSync(configuration.activeProfileFile, profileName, 'utf-8');
        logger.debug(`[!auth] Wrote global active profile: ${profileName}`);
    } catch (err) {
        logger.debug('[!auth] Failed to write global profile file:', err);
        return {
            message: ['❌ 广播配置切换失败'],
            action: 'none',
        };
    }

    const usageLine = getCachedUsageSummary(target.instancePath);
    const messages = [`✅ 已广播切换到 "${profileName}"`, `组 "${groupName}" 中的所有会话`];
    if (usageLine) messages.push(usageLine);
    return { message: messages, action: 'none' };
}
