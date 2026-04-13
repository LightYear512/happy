import { existsSync, readFileSync, writeFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import {
    readCcsProfiles,
    getCurrentProfileForFlavor,
    applyProfileSwitch,
    readCodexProfiles,
    readCodexDefaultProfile,
    setCodexDefaultProfile,
    setCcsDefaultProfile,
    type CcsProfileInfo,
    type AuthFlavor,
} from './ccsProfiles';
import { configuration } from '@/configuration';
import { getCachedUsageSummary, readOAuthToken, fetchProfileUsageSummary, type ProfileUsageEntry } from './usageCommand';
import { formatRelativeTime } from './relativeTime';
import { SEPARATOR, parseCodexFlag, rejectCodexFlagInSession, type BangCommandContext, type BangCommandResult } from './types';

/** Convert CodexProfileInfo[] to CcsProfileInfo[] for unified profile handling. */
function codexToCcsProfiles(codexProfiles: ReturnType<typeof readCodexProfiles>): CcsProfileInfo[] {
    return codexProfiles.map(cp => ({
        name: cp.name,
        instancePath: cp.codexHome,
        contextMode: cp.contextMode,
    }));
}

/** Map context flavor to the auth-relevant subset (gemini/undefined → claude). */
export function resolveAuthFlavor(ctx: BangCommandContext): AuthFlavor {
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
    const codexReject = rejectCodexFlagInSession(args, ctx);
    if (codexReject) return codexReject;

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
        const filePath = flavor === 'codex'
            ? configuration.activeCodexProfileFile
            : configuration.activeProfileFile;
        if (!existsSync(filePath)) return false;

        const profileName = readFileSync(filePath, 'utf-8').trim();
        if (!profileName) return false;

        const currentProfile = getCurrentProfileForFlavor(flavor);
        if (profileName === currentProfile) return false;

        const { profiles: ccsProfiles } = readCcsProfiles();
        const profiles: CcsProfileInfo[] = flavor === 'codex'
            ? codexToCcsProfiles(readCodexProfiles())
            : ccsProfiles;
        const target = profiles.find(p => p.name === profileName);
        if (!target) {
            logger.debug(`[!auth] Global switch: profile "${profileName}" not found`);
            return false;
        }

        const currentProfileInfo = currentProfile
            ? profiles.find(p => p.name === currentProfile) ?? null
            : null;
        if (!isSharedContext(currentProfileInfo, target)) {
            logger.debug(`[!auth] Global switch: "${profileName}" not in shared mode, ignoring`);
            return false;
        }

        if (flavor === 'codex') {
            // profiles already built from readCodexProfiles() — no need to re-read
            if (!profiles.some(p => p.name === profileName)) {
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
 * The returned map carries both summary and authExpired status so callers can
 * surface a refresh hint when a profile's OAuth token has expired.
 */
async function fetchUsageSummaries(profileNames: string[], flavor: AuthFlavor): Promise<Map<string, ProfileUsageEntry>> {
    const results = await Promise.all(
        profileNames.map(async name => ({
            name,
            entry: await fetchProfileUsageSummary(name, flavor),
        }))
    );
    const map = new Map<string, ProfileUsageEntry>();
    for (const { name, entry } of results) {
        map.set(name, entry);
    }
    return map;
}

/** Format a profile line with optional usage summary, stale marker, auth-expired marker and default indicator. */
function profileLine(marker: string, name: string, status: string, entry: ProfileUsageEntry | undefined, isDefault?: boolean): string {
    const parts = [marker, name];
    if (isDefault) parts.push('(默认)');
    if (status) parts.push(status);
    if (entry?.summary) {
        parts.push(entry.summary);
        if (entry.stale && entry.cachedAt) {
            parts.push(`⏳ ${formatRelativeTime(entry.cachedAt)}`);
        }
        if (entry.authExpired) {
            parts.push('🔒 令牌过期');
        }
    } else if (entry?.authExpired) {
        parts.push('🔒 令牌过期');
    }
    return parts.filter(Boolean).join(' ');
}

/** True if any profile entry in the map has an expired OAuth token. */
function hasAuthExpired(map: Map<string, ProfileUsageEntry>): boolean {
    for (const entry of map.values()) {
        if (entry.authExpired) return true;
    }
    return false;
}

const REFRESH_HINT = '💡 令牌过期：切换到该账号并发送任意消息即可刷新令牌';

async function listProfiles(isConsole: boolean, flavor: AuthFlavor = 'claude'): Promise<BangCommandResult> {
    const { profiles: ccsProfiles } = readCcsProfiles();
    const codexProfiles = flavor === 'codex' ? readCodexProfiles() : [];

    if (flavor === 'codex' && codexProfiles.length === 0) {
        return { message: '❌ 未找到已登录的 Codex 账户。', action: 'none' };
    }

    // For codex flavor, build CcsProfileInfo from codex profiles (which carry contextMode from codex config.yaml)
    const profiles: CcsProfileInfo[] = flavor === 'codex'
        ? codexToCcsProfiles(codexProfiles)
        : ccsProfiles;

    const currentProfile = getCurrentProfileForFlavor(flavor);
    const codexNames = flavor === 'codex' ? new Set(codexProfiles.map(p => p.name)) : undefined;
    const codexDefault = flavor === 'codex' ? readCodexDefaultProfile() : null;
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
                messages.push(profileLine('○', p.name, status, usageMap.get(p.name), p.name === codexDefault));
            }
            messages.push(SEPARATOR);
            if (hasAuthExpired(usageMap)) messages.push(REFRESH_HINT);
        } else {
            messages.push('未找到 CCS 配置。');
        }
        return { message: messages, action: 'none' };
    }

    const isShared = currentProfileInfo?.contextMode === 'shared';

    // Console: no "current" concept — list all shared profiles equally
    if (isConsole) {
        const sharedProfiles = isShared ? profiles.filter(p => p.contextMode === 'shared') : [];

        const usageMap = await fetchUsageSummaries(sharedProfiles.map(p => p.name), flavor);
        const codexFlag = flavor === 'codex' ? ' --codex' : '';
        const messages: string[] = [`📋 共享账号 (${flavorLabel})`];
        messages.push(SEPARATOR);
        for (const p of sharedProfiles) {
            const status = getProfileStatus(p, flavor, codexNames);
            messages.push(profileLine('', p.name, status, usageMap.get(p.name), p.name === codexDefault));
        }
        messages.push(SEPARATOR);

        if (sharedProfiles.length > 1) {
            messages.push(`!auth-all <名称>${codexFlag} → 切换全部会话`);
            if (hasAuthExpired(usageMap)) messages.push(REFRESH_HINT);
            const suggestions = sharedProfiles.map(p => `!auth-all ${p.name}${codexFlag}`);
            return { message: messages, action: 'none', suggestions };
        } else {
            messages.push('暂无其他可切换账号。');
            if (hasAuthExpired(usageMap)) messages.push(REFRESH_HINT);
            return { message: messages, action: 'none' };
        }
    }

    // Normal session: show current profile with ● indicator
    const switchable = isShared
        ? profiles.filter(p => p.contextMode === 'shared' && p.name !== currentProfile)
        : [];

    const allShared = [currentProfile, ...switchable.map(p => p.name)];
    const usageMap = await fetchUsageSummaries(allShared, flavor);
    const messages: string[] = [];

    if (isShared) {
        messages.push(`📋 共享账号 (${flavorLabel})`);
    } else {
        messages.push(`📋 ${currentProfile} (独立, ${flavorLabel})`);
    }

    const currentStatus = currentProfileInfo ? getProfileStatus(currentProfileInfo, flavor, codexNames) : '';

    messages.push(SEPARATOR);
    messages.push(profileLine('●', currentProfile, currentStatus, usageMap.get(currentProfile), currentProfile === codexDefault));

    if (isShared && switchable.length > 0) {
        for (const profile of switchable) {
            const status = getProfileStatus(profile, flavor, codexNames);
            messages.push(profileLine('○', profile.name, status, usageMap.get(profile.name), profile.name === codexDefault));
        }
        messages.push(SEPARATOR);
        messages.push('!auth <名称> → 切换当前会话');
        if (hasAuthExpired(usageMap)) messages.push(REFRESH_HINT);

        const suggestions = switchable.map(p => `!auth ${p.name}`);
        return { message: messages, action: 'none', suggestions };
    } else if (isShared) {
        messages.push(SEPARATOR);
        messages.push('暂无其他可切换账号。');
        if (hasAuthExpired(usageMap)) messages.push(REFRESH_HINT);
    } else {
        messages.push(SEPARATOR);
        messages.push('无法切换。');
        if (hasAuthExpired(usageMap)) messages.push(REFRESH_HINT);
    }

    return { message: messages, action: 'none' };
}

/**
 * True when both source and target are in shared mode — switching between
 * them should NOT reset the session. Single-default-group model: all shared
 * profiles live in the same group, so mode equality is sufficient.
 */
function isSharedContext(
    source: CcsProfileInfo | null,
    target: CcsProfileInfo,
): boolean {
    return source?.contextMode === 'shared' && target.contextMode === 'shared';
}

function switchProfile(profileName: string, flavor: AuthFlavor = 'claude'): BangCommandResult {
    const { profiles: ccsProfiles } = readCcsProfiles();
    const profiles: CcsProfileInfo[] = flavor === 'codex'
        ? codexToCcsProfiles(readCodexProfiles())
        : ccsProfiles;
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
        return {
            message: [
                '❌ 无法切换',
                `"${currentProfile || 'unknown'}" → ${describeContextMode(currentProfileInfo)}`,
                `"${profileName}" → ${describeContextMode(target)}`,
            ],
            action: 'none',
        };
    }

    // Verify the relevant instance directory exists
    if (flavor === 'codex') {
        // profiles already built from readCodexProfiles() — no need to re-read
        if (!profiles.some(p => p.name === profileName)) {
            return { message: `❌ Codex 配置 "${profileName}" 未初始化（无 auth.json）。`, action: 'none' };
        }
    } else {
        if (!existsSync(target.instancePath)) {
            return { message: `❌ 配置 "${profileName}" 未初始化。`, action: 'none' };
        }
    }

    // Perform the env-level switch
    applyProfileSwitch(profileName, flavor, target.instancePath);
    const defaultUpdated = tryPersistDefaultProfile(profileName, flavor);

    const usageLine = flavor !== 'codex' ? getCachedUsageSummary(target.instancePath) : null;
    const messages = [`✅ 已切换到 "${profileName}"`];
    messages.push(defaultProfileMessage(profileName, defaultUpdated));
    if (usageLine) messages.push(usageLine);
    return { message: messages, action: 'restart-session' };
}

/**
 * Persist the selected profile as the default so newly-spawned sessions
 * pick up the new account without waiting for the fs.watch broadcast.
 */
function tryPersistDefaultProfile(profileName: string, flavor: AuthFlavor): boolean {
    try {
        if (flavor === 'codex') {
            setCodexDefaultProfile(profileName);
        } else {
            setCcsDefaultProfile(profileName);
        }
        return true;
    } catch (err) {
        logger.debug('[!auth] Failed to update default profile:', err);
        return false;
    }
}

function defaultProfileMessage(profileName: string, updated: boolean): string {
    return updated
        ? `默认账号已更新 → 新会话将使用 "${profileName}"`
        : '⚠ 默认账号未更新（新会话仍使用旧默认）';
}

/**
 * Switch all sessions on this machine to the specified profile.
 * Validates and switches the current session, then writes the profile name
 * to a global file so other sessions pick it up via fs.watch.
 */
function switchAllProfiles(profileName: string, flavor: AuthFlavor = 'claude'): BangCommandResult {
    const { profiles: ccsProfiles } = readCcsProfiles();
    const profiles: CcsProfileInfo[] = flavor === 'codex'
        ? codexToCcsProfiles(readCodexProfiles())
        : ccsProfiles;
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
        return {
            message: [
                '❌ 无法切换',
                `"${currentProfile || 'unknown'}" → ${describeContextMode(currentProfileInfo)}`,
                `"${profileName}" → ${describeContextMode(target)}`,
            ],
            action: 'none',
        };
    }

    if (!existsSync(target.instancePath)) {
        return { message: `❌ 配置 "${profileName}" 未初始化。`, action: 'none' };
    }

    // Write global file so other sessions pick up the change via fs.watch
    const broadcastFile = flavor === 'codex'
        ? configuration.activeCodexProfileFile
        : configuration.activeProfileFile;
    try {
        writeFileSync(broadcastFile, profileName, 'utf-8');
        logger.debug(`[!auth] Wrote global active profile (${flavor}): ${profileName}`);
    } catch (err) {
        logger.debug('[!auth] Failed to write global profile file:', err);
        return {
            message: ['❌ 广播配置切换失败'],
            action: 'none',
        };
    }

    const defaultUpdated = tryPersistDefaultProfile(profileName, flavor);

    const usageLine = getCachedUsageSummary(target.instancePath);
    const messages = [`✅ 已广播切换到 "${profileName}"`, '所有共享会话'];
    messages.push(defaultProfileMessage(profileName, defaultUpdated));
    if (usageLine) messages.push(usageLine);
    return { message: messages, action: 'none' };
}

/** Render a profile's context mode for error messages. */
function describeContextMode(p: CcsProfileInfo | null): string {
    return p?.contextMode === 'shared' ? '共享' : '独立';
}

/**
 * Watch the global codex profile broadcast file and invoke `onSwitch` whenever
 * a valid profile switch was applied (env updated, same context group).
 *
 * Mirrors the claude-side fs.watch wiring in claudeRemoteLauncher but targets
 * `active-codex-profile`. Callers get a notification after the env has already
 * been updated by `tryGlobalProfileSwitch('codex')` — they only need to react
 * (abort turn, restart subprocess, etc.).
 *
 * Returns null when the watcher could not be set up (errors are logged).
 * Callers must `.close()` the returned watcher during cleanup.
 */
export function watchCodexProfileFile(onSwitch: () => void): FSWatcher | null {
    let debounceTimer: NodeJS.Timeout | null = null;
    try {
        const watcher = watch(configuration.happyHomeDir, (_event, filename) => {
            if (filename !== 'active-codex-profile') return;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const switched = tryGlobalProfileSwitch('codex');
                if (switched) {
                    onSwitch();
                }
            }, 200);
        });
        watcher.on('error', (err) => {
            logger.debug('[!auth] Codex profile watcher error:', err);
        });
        return watcher;
    } catch (err) {
        logger.debug('[!auth] Failed to set up codex profile watcher:', err);
        return null;
    }
}
