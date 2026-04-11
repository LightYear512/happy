import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import {
    readCcsProfiles,
    getCurrentProfileForFlavor,
    applyProfileSwitch,
    readCodexProfiles,
    type CcsProfileInfo,
    type AuthFlavor,
} from './ccsProfiles';
import { configuration } from '@/configuration';
import { getCachedUsageSummary, readOAuthToken, fetchProfileUsageSummary } from './usageCommand';
import { SEPARATOR, parseCodexFlag, type BangCommandContext, type BangCommandResult } from './types';

/** Map context flavor to the auth-relevant subset (gemini/undefined → claude). */
function resolveAuthFlavor(ctx: BangCommandContext): AuthFlavor {
    return ctx.flavor === 'codex' ? 'codex' : 'claude';
}

/**
 * Handle the `!auth` bang command.
 *
 * In normal sessions:
 * - `!auth` — List available CCS profiles with current active indicator
 * - `!auth <name>` — Switch current session to the specified profile
 *
 * In console:
 * - `!auth` — List available CCS profiles (use !auth-all to switch all sessions)
 */
export async function handleAuthBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const { cleanArgs, hasCodexFlag } = parseCodexFlag(args);
    // In console: no ctx.flavor, use --codex flag; in session: ctx.flavor takes precedence
    const flavor: AuthFlavor = hasCodexFlag ? 'codex' : resolveAuthFlavor(ctx);

    if (!cleanArgs) {
        return listProfiles(!!ctx.isConsoleSession, flavor);
    }

    if (ctx.isConsoleSession) {
        return {
            message: ['❌ 控制台中请使用 !auth-all <name> 切换所有会话'],
            action: 'none',
            suggestions: ['!auth-all'],
        };
    }

    return switchProfile(cleanArgs, flavor);
}

/**
 * Handle the `!auth-all` bang command (console only).
 *
 * - `!auth-all` — List available CCS profiles
 * - `!auth-all <name>` — Switch all sessions on this machine to the specified profile
 */
export async function handleAuthAllBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const { cleanArgs, hasCodexFlag } = parseCodexFlag(args);
    const flavor: AuthFlavor = hasCodexFlag ? 'codex' : resolveAuthFlavor(ctx);

    if (!cleanArgs) {
        return listProfiles(true, flavor);
    }

    return switchAllProfiles(cleanArgs, flavor);
}

/**
 * Attempt to switch to the profile specified in the global active-ccs-profile file.
 * Called by the fs.watch handler in claudeRemoteLauncher when the file changes.
 * Returns true if a switch occurred, false otherwise.
 */
export function tryGlobalProfileSwitch(flavor: AuthFlavor = 'claude'): boolean {
    try {
        const filePath = configuration.activeProfileFile;
        if (!existsSync(filePath)) return false;

        const profileName = readFileSync(filePath, 'utf-8').trim();
        if (!profileName) return false;

        const currentProfile = getCurrentProfileForFlavor(flavor);
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

        if (flavor === 'codex') {
            if (!readCodexProfiles().some(p => p.name === profileName)) {
                logger.warn(`[!auth] Global switch: codex profile "${profileName}" has no auth.json, skipping`);
                return false;
            }
        } else {
            if (!existsSync(target.instancePath)) {
                logger.warn(`[!auth] Global switch: profile "${profileName}" instance not initialized (${target.instancePath}), skipping`);
                return false;
            }
        }

        applyProfileSwitch(profileName, flavor, target.instancePath);
        return true;
    } catch (err) {
        logger.debug('[!auth] Global profile switch error:', err);
        return false;
    }
}

/**
 * Check whether a profile's auth is available and likely valid.
 * Returns a status indicator: '' (ok), '⚠' (no token / not initialized).
 */
function getProfileStatus(profile: CcsProfileInfo, flavor: AuthFlavor = 'claude', codexNames?: Set<string>): string {
    if (flavor === 'codex') {
        const names = codexNames ?? new Set(readCodexProfiles().map(p => p.name));
        return names.has(profile.name) ? '' : '⚠';
    }
    if (!existsSync(profile.instancePath)) return '⚠';
    if (!readOAuthToken(profile.instancePath)) return '⚠';
    return '';
}

/**
 * Fetch usage summaries for a list of profiles in parallel.
 * Each call is individually bounded by a 5s timeout inside fetchProfileUsageSummary.
 */
async function fetchUsageSummaries(profileNames: string[], flavor: AuthFlavor): Promise<Map<string, string>> {
    const results = await Promise.all(
        profileNames.map(async name => ({
            name,
            summary: await fetchProfileUsageSummary(name, flavor),
        }))
    );
    const map = new Map<string, string>();
    for (const { name, summary } of results) {
        if (summary) map.set(name, summary);
    }
    return map;
}

/** Format a profile line with optional usage summary. */
function profileLine(marker: string, name: string, status: string, usage: string | undefined): string {
    const parts = [marker, name];
    if (status) parts.push(status);
    if (usage) parts.push(usage);
    return parts.filter(Boolean).join(' ');
}

async function listProfiles(isConsole: boolean, flavor: AuthFlavor = 'claude'): Promise<BangCommandResult> {
    const { profiles } = readCcsProfiles();
    const currentProfile = getCurrentProfileForFlavor(flavor);
    const codexNames = flavor === 'codex' ? new Set(readCodexProfiles().map(p => p.name)) : undefined;
    const currentProfileInfo = currentProfile
        ? profiles.find(p => p.name === currentProfile) ?? null
        : null;

    const flavorLabel = flavor === 'codex' ? 'Codex' : 'Claude';

    // No active CCS profile (session not started via CCS)
    if (!currentProfile) {
        const messages: string[] = [`📋 当前无 CCS 配置。(${flavorLabel})`];
        if (profiles.length > 0) {
            const usageMap = await fetchUsageSummaries(profiles.map(p => p.name), flavor);
            messages.push(SEPARATOR);
            for (const p of profiles) {
                const status = getProfileStatus(p, flavor, codexNames);
                messages.push(profileLine('○', p.name, status, usageMap.get(p.name)));
            }
            messages.push(SEPARATOR);
        } else {
            messages.push('未找到 CCS 配置。');
        }
        return { message: messages, action: 'none' };
    }

    const isShared = currentProfileInfo?.contextMode === 'shared';
    const currentGroup = isShared ? (currentProfileInfo.contextGroup || 'default') : null;

    // Console: no "current" concept — list all profiles in the group equally
    if (isConsole) {
        const groupProfiles = currentGroup
            ? profiles.filter(p => p.contextMode === 'shared' && (p.contextGroup || 'default') === currentGroup)
            : [];

        const usageMap = await fetchUsageSummaries(groupProfiles.map(p => p.name), flavor);
        const codexFlag = flavor === 'codex' ? ' --codex' : '';
        const messages: string[] = [];
        if (currentGroup) {
            messages.push(`📋 组 "${currentGroup}" (${flavorLabel})`);
        }
        messages.push(SEPARATOR);
        for (const p of groupProfiles) {
            const status = getProfileStatus(p, flavor, codexNames);
            messages.push(profileLine('', p.name, status, usageMap.get(p.name)));
        }
        messages.push(SEPARATOR);

        if (groupProfiles.length > 1) {
            messages.push(`!auth-all <名称>${codexFlag} → 切换全部会话`);
            const suggestions = groupProfiles.map(p => `!auth-all ${p.name}${codexFlag}`);
            return { message: messages, action: 'none', suggestions };
        } else {
            messages.push('本组无其他账号。');
            return { message: messages, action: 'none' };
        }
    }

    // Normal session: show current profile with ● indicator
    const switchable = currentGroup
        ? profiles.filter(p =>
            p.contextMode === 'shared'
            && (p.contextGroup || 'default') === currentGroup
            && p.name !== currentProfile)
        : [];

    const allInGroup = [currentProfile, ...switchable.map(p => p.name)];
    const usageMap = await fetchUsageSummaries(allInGroup, flavor);
    const messages: string[] = [];

    if (currentGroup) {
        messages.push(`📋 组 "${currentGroup}" (${flavorLabel})`);
    } else {
        messages.push(`📋 ${currentProfile} (独立, ${flavorLabel})`);
    }

    const currentStatus = currentProfileInfo ? getProfileStatus(currentProfileInfo, flavor, codexNames) : '';

    messages.push(SEPARATOR);
    messages.push(profileLine('●', currentProfile, currentStatus, usageMap.get(currentProfile)));

    if (currentGroup && switchable.length > 0) {
        for (const profile of switchable) {
            const status = getProfileStatus(profile, flavor, codexNames);
            messages.push(profileLine('○', profile.name, status, usageMap.get(profile.name)));
        }
        messages.push(SEPARATOR);
        messages.push('!auth <名称> → 切换当前会话');

        const suggestions = switchable.map(p => `!auth ${p.name}`);
        return { message: messages, action: 'none', suggestions };
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

function switchProfile(profileName: string, flavor: AuthFlavor = 'claude'): BangCommandResult {
    const { profiles } = readCcsProfiles();
    const currentProfile = getCurrentProfileForFlavor(flavor);

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

    // Verify the relevant instance directory exists
    if (flavor === 'codex') {
        if (!readCodexProfiles().some(p => p.name === profileName)) {
            return { message: `❌ Codex 配置 "${profileName}" 未初始化（无 auth.json）。`, action: 'none' };
        }
    } else {
        if (!existsSync(target.instancePath)) {
            return { message: `❌ 配置 "${profileName}" 未初始化。`, action: 'none' };
        }
    }

    // Perform the env-level switch
    applyProfileSwitch(profileName, flavor, target.instancePath);

    const usageLine = flavor !== 'codex' ? getCachedUsageSummary(target.instancePath) : null;
    const messages = [`✅ 已切换到 "${profileName}"`];
    if (usageLine) messages.push(usageLine);
    return { message: messages, action: 'restart-session' };
}

/**
 * Switch all sessions on this machine to the specified profile.
 * Validates and switches the current session, then writes the profile name
 * to a global file so other sessions pick it up via fs.watch.
 */
function switchAllProfiles(profileName: string, flavor: AuthFlavor = 'claude'): BangCommandResult {
    const { profiles } = readCcsProfiles();
    const currentProfile = getCurrentProfileForFlavor(flavor);
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
