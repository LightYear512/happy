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
 * Called by the fs.watch handler in runClaude when the file changes.
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

        if (flavor === 'codex') {
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

function getProfileStatus(profile: CcsProfileInfo, flavor: AuthFlavor = 'claude', codexNames?: Set<string>): string {
    if (flavor === 'codex') {
        const names = codexNames ?? new Set(readCodexProfiles().map(p => p.name));
        return names.has(profile.name) ? '' : '⚠';
    }
    if (!existsSync(profile.instancePath)) return '⚠';
    if (!readOAuthToken(profile.instancePath)) return '⚠';
    return '';
}

async function fetchUsageSummaries(profileNames: string[], flavor: AuthFlavor): Promise<Map<string, ProfileUsageEntry>> {
    const results = await Promise.all(
        profileNames.map(async name => ({
            name,
            entry: await fetchProfileUsageSummary(name, flavor),
        }))
    );
    const map = new Map<string, ProfileUsageEntry>();
    for (const { name, entry } of results) map.set(name, entry);
    return map;
}

function profileLine(marker: string, name: string, status: string, entry: ProfileUsageEntry | undefined, isDefault?: boolean): string {
    const parts = [marker, name];
    if (isDefault) parts.push('(默认)');
    if (status) parts.push(status);
    if (entry?.summary) {
        parts.push(entry.summary);
        if (entry.stale && entry.cachedAt) parts.push(`⏳ ${formatRelativeTime(entry.cachedAt)}`);
        if (entry.authExpired) parts.push('🔒 令牌过期');
    } else if (entry?.authExpired) {
        parts.push('🔒 令牌过期');
    }
    return parts.filter(Boolean).join(' ');
}

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

    const profiles: CcsProfileInfo[] = flavor === 'codex'
        ? codexToCcsProfiles(codexProfiles)
        : ccsProfiles;

    const codexNames = flavor === 'codex' ? new Set(codexProfiles.map(p => p.name)) : undefined;
    const codexDefault = flavor === 'codex' ? readCodexDefaultProfile() : null;
    const flavorLabel = flavor === 'codex' ? 'Codex' : 'Claude';

    if (isConsole) {
        if (profiles.length === 0) {
            return { message: `❌ 未找到 CCS 配置。(${flavorLabel})`, action: 'none' };
        }
        const usageMap = await fetchUsageSummaries(profiles.map(p => p.name), flavor);
        const codexPrefix = flavor === 'codex' ? '--codex ' : '';
        const messages: string[] = [`📋 账号列表 (${flavorLabel})`];
        messages.push(SEPARATOR);
        for (const p of profiles) {
            const status = getProfileStatus(p, flavor, codexNames);
            messages.push(profileLine('', p.name, status, usageMap.get(p.name), p.name === codexDefault));
        }
        messages.push(SEPARATOR);
        if (profiles.length > 1) {
            messages.push(`!auth-all ${codexPrefix}<名称> → 切换全部会话`);
            if (hasAuthExpired(usageMap)) messages.push(REFRESH_HINT);
            const suggestions = profiles.map(p => `!auth-all ${codexPrefix}${p.name}`);
            return { message: messages, action: 'none', suggestions };
        }
        messages.push('暂无其他可切换账号。');
        if (hasAuthExpired(usageMap)) messages.push(REFRESH_HINT);
        return { message: messages, action: 'none' };
    }

    const currentProfile = getCurrentProfileForFlavor(flavor);

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

    const switchable = profiles.filter(p => p.name !== currentProfile);
    const usageMap = await fetchUsageSummaries(profiles.map(p => p.name), flavor);
    const messages: string[] = [`📋 账号列表 (${flavorLabel})`];
    const current = profiles.find(p => p.name === currentProfile);
    const currentStatus = current ? getProfileStatus(current, flavor, codexNames) : '';
    messages.push(SEPARATOR);
    messages.push(profileLine('●', currentProfile, currentStatus, usageMap.get(currentProfile), currentProfile === codexDefault));

    if (switchable.length > 0) {
        for (const profile of switchable) {
            const status = getProfileStatus(profile, flavor, codexNames);
            messages.push(profileLine('○', profile.name, status, usageMap.get(profile.name), profile.name === codexDefault));
        }
        messages.push(SEPARATOR);
        messages.push('!auth <名称> → 切换当前会话');
        if (hasAuthExpired(usageMap)) messages.push(REFRESH_HINT);
        const suggestions = switchable.map(p => `!auth ${p.name}`);
        return { message: messages, action: 'none', suggestions };
    }

    messages.push(SEPARATOR);
    messages.push('暂无其他可切换账号。');
    if (hasAuthExpired(usageMap)) messages.push(REFRESH_HINT);
    return { message: messages, action: 'none' };
}

function switchProfile(profileName: string, flavor: AuthFlavor = 'claude'): BangCommandResult {
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

    if (target.name === currentProfile) {
        return { message: `✅ 当前已是 "${profileName}"`, action: 'none' };
    }

    if (flavor === 'codex') {
        if (!profiles.some(p => p.name === profileName)) {
            return { message: `❌ Codex 配置 "${profileName}" 未初始化（无 auth.json）。`, action: 'none' };
        }
    } else {
        if (!existsSync(target.instancePath)) {
            return { message: `❌ 配置 "${profileName}" 未初始化。`, action: 'none' };
        }
    }

    applyProfileSwitch(profileName, flavor, target.instancePath);
    const defaultUpdated = tryPersistDefaultProfile(profileName, flavor);
    const usageLine = flavor !== 'codex' ? getCachedUsageSummary(target.instancePath) : null;
    const messages = [`✅ 已切换到 "${profileName}"`];
    messages.push(defaultProfileMessage(profileName, defaultUpdated));
    if (usageLine) messages.push(usageLine);
    return { message: messages, action: 'restart-session' };
}

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

function switchAllProfiles(profileName: string, flavor: AuthFlavor = 'claude'): BangCommandResult {
    const { profiles: ccsProfiles } = readCcsProfiles();
    const profiles: CcsProfileInfo[] = flavor === 'codex'
        ? codexToCcsProfiles(readCodexProfiles())
        : ccsProfiles;
    const target = profiles.find(p => p.name === profileName);

    if (!target) {
        return {
            message: [`❌ 未找到配置 "${profileName}"。`, '使用 !auth 查看可用账号。'],
            action: 'none',
        };
    }

    if (!existsSync(target.instancePath)) {
        return { message: `❌ 配置 "${profileName}" 未初始化。`, action: 'none' };
    }

    const broadcastFile = flavor === 'codex'
        ? configuration.activeCodexProfileFile
        : configuration.activeProfileFile;
    try {
        writeFileSync(broadcastFile, profileName, 'utf-8');
        logger.debug(`[!auth] Wrote global active profile (${flavor}): ${profileName}`);
    } catch (err) {
        logger.debug('[!auth] Failed to write global profile file:', err);
        return { message: ['❌ 广播配置切换失败'], action: 'none' };
    }

    const defaultUpdated = tryPersistDefaultProfile(profileName, flavor);
    const usageLine = getCachedUsageSummary(target.instancePath);
    const messages = [`✅ 已广播切换到 "${profileName}"`, '所有共享会话'];
    messages.push(defaultProfileMessage(profileName, defaultUpdated));
    if (usageLine) messages.push(usageLine);
    return { message: messages, action: 'none' };
}

/**
 * Watch the global codex profile broadcast file and invoke `onSwitch` whenever
 * a valid profile switch was applied.
 */
export function watchCodexProfileFile(onSwitch: () => void): FSWatcher | null {
    let debounceTimer: NodeJS.Timeout | null = null;
    try {
        const watcher = watch(configuration.happyHomeDir, (_event, filename) => {
            if (filename !== 'active-codex-profile') return;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const switched = tryGlobalProfileSwitch('codex');
                if (switched) onSwitch();
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
