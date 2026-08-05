import { existsSync } from 'node:fs';
import { logger } from '@/ui/logger';
import {
    readCcsProfiles,
    getCurrentProfileForFlavor,
    applyProfileSwitch,
    readCodexProfiles,
    readCodexDefaultProfile,
    type CcsProfileInfo,
    type AuthFlavor,
} from './ccsProfiles';
import { getCachedUsageSummary, getCachedProfileUsageEntry, fetchProfileUsageSummary, readOAuthToken, type ProfileUsageEntry } from './usageCommand';
import { parseCodexFlag, rejectCodexFlagInSession, type BangCommandContext, type BangCommandResult } from './types';
import {
    publishAccountIntent,
    readAccountIntent,
    writeSessionAccountSelection,
} from './accountIntent';

type ProfileOptionSuggestion = {
    label: string;
    value: string;
    disabled: boolean;
    sortGroup: number;
    sortValue: number;
    name: string;
    unavailableDelayMs: number | null;
    unavailablePrefix: string | null;
};

const OPTION_INFO_SEPARATOR = '｜';
const LEGACY_DEFAULT_PROFILE_MARKER = '🟢';
const DEFAULT_PROFILE_MARKER = '💚';
const DEFAULT_HIGH_USAGE_PROFILE_MARKER = '💔';
const USABLE_PROFILE_MARKER = '🔵';
const UNAVAILABLE_PROFILE_MARKER = '🚫';
const GUESS_AVAILABLE_PROFILE_MARKER = '🟣';
const ACCOUNT_SWITCH_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_HIGH_USAGE_PERCENT = 85;
const UNAVAILABLE_DAY_MARKERS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'] as const;

function isProfileUnavailable(status: string, entry: ProfileUsageEntry | undefined): boolean {
    return !!status || !!entry?.authExpired || isFiveHourBlocked(entry) || isSevenDayBlocked(entry);
}

function defaultProfileHighUsage(entry: ProfileUsageEntry | undefined): boolean {
    return (entry?.fiveHourPercent != null && entry.fiveHourPercent > DEFAULT_HIGH_USAGE_PERCENT)
        || (entry?.sevenDayPercent != null && entry.sevenDayPercent > DEFAULT_HIGH_USAGE_PERCENT);
}

function profileMarker(isDefault: boolean, status: string, entry: ProfileUsageEntry | undefined): string {
    if (isDefault && defaultProfileHighUsage(entry)) return DEFAULT_HIGH_USAGE_PROFILE_MARKER;
    if (isProfileUnavailable(status, entry)) return UNAVAILABLE_PROFILE_MARKER;
    if (isGuessAvailableAfterReset(entry)) return GUESS_AVAILABLE_PROFILE_MARKER;
    if (isDefault) return DEFAULT_PROFILE_MARKER;
    return USABLE_PROFILE_MARKER;
}

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
 * - `!auth` — List available CCS profiles (use !auth-all to set the global account)
 */
export async function handleAuthBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const codexReject = rejectCodexFlagInSession(args, ctx);
    if (codexReject) return codexReject;

    const { cleanArgs, hasCodexFlag } = parseCodexFlag(args);
    // In console: no ctx.flavor, use --codex flag; in session: ctx.flavor takes precedence
    const flavor: AuthFlavor = hasCodexFlag ? 'codex' : resolveAuthFlavor(ctx);

    if (!cleanArgs) {
        ctx.client.sendSessionEvent({ type: 'message', message: '⏳ 账号信息查询中' });
        return listProfiles(!!ctx.isConsoleSession, flavor);
    }

    if (ctx.isConsoleSession) {
        return {
            message: ['❌ 控制台中请使用 !auth-all <name> 设置全局账号'],
            action: 'none',
            suggestions: ['!auth-all'],
        };
    }

    return switchProfile(cleanArgs, flavor, ctx.deferCodexProfileSwitch === true, ctx);
}

/**
 * Handle the `!auth-all` bang command (console only).
 *
 * - `!auth-all` — List available CCS profiles
 * - `!auth-all <name>` — Record a newer global profile for sessions to apply at their next input
 */
export async function handleAuthAllBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const { cleanArgs, hasCodexFlag } = parseCodexFlag(args);
    const flavor: AuthFlavor = hasCodexFlag ? 'codex' : resolveAuthFlavor(ctx);

    if (!cleanArgs) {
        ctx.client.sendSessionEvent({ type: 'message', message: '⏳ 账号信息查询中' });
        return listProfiles(true, flavor);
    }

    return switchAllProfiles(cleanArgs, flavor);
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

/** Read usage summaries from the shared file-backed cache. */
function readCachedUsageSummaries(profileNames: string[], flavor: AuthFlavor): Map<string, ProfileUsageEntry> {
    const map = new Map<string, ProfileUsageEntry>();
    for (const name of profileNames) {
        const entry = getCachedProfileUsageEntry(name, flavor);
        if (entry) map.set(name, entry);
    }
    return map;
}

async function loadConsoleUsageSummaries(
    profileNames: string[],
    flavor: AuthFlavor,
): Promise<Map<string, ProfileUsageEntry>> {
    const usageMap = new Map<string, ProfileUsageEntry>();
    const now = Date.now();
    await Promise.all(profileNames.map(async name => {
        const cached = getCachedProfileUsageEntry(name, flavor);
        if (cached?.cachedAt != null && now - cached.cachedAt <= ACCOUNT_SWITCH_CACHE_TTL_MS) {
            usageMap.set(name, cached);
            return;
        }

        try {
            const fresh = await fetchProfileUsageSummary(name, flavor);
            if (fresh.summary || fresh.cachedAt || fresh.authExpired) {
                usageMap.set(name, fresh);
            }
        } catch (err) {
            logger.debug(`[!auth] console usage refresh failed for ${name}:`, err);
        }
    }));
    return usageMap;
}

async function refreshMissingCodexUsageSummaries(
    profileNames: string[],
    flavor: AuthFlavor,
    usageMap: Map<string, ProfileUsageEntry>
): Promise<void> {
    if (flavor !== 'codex') return;
    const missing = profileNames.filter(name => !usageMap.has(name));
    if (missing.length === 0) return;

    const tasks = missing.map(async name => {
        try {
            const entry = await fetchProfileUsageSummary(name, flavor);
            if (entry.summary || entry.cachedAt || entry.authExpired) usageMap.set(name, entry);
        } catch (err) {
            logger.debug(`[!auth] codex usage refresh skipped for ${name}:`, err);
        }
    });

    await Promise.race([
        Promise.allSettled(tasks),
        new Promise(resolve => setTimeout(resolve, 1800)),
    ]);
}

function formatCompactResetTime(resetsAt: string | null | undefined): string | null {
    if (!resetsAt) return null;
    const resetDate = new Date(resetsAt);
    const diffMs = resetDate.getTime() - Date.now();
    if (!Number.isFinite(diffMs)) return null;
    const totalMin = Math.max(0, Math.ceil(diffMs / 60000));
    const hours = Math.floor(totalMin / 60);
    const minutes = totalMin % 60;
    return `下${hours}:${minutes.toString().padStart(2, '0')}时`;
}

function formatCompactSevenDayResetTime(resetsAt: string | null | undefined): string | null {
    if (!resetsAt) return null;
    const resetDate = new Date(resetsAt);
    const diffMs = resetDate.getTime() - Date.now();
    if (!Number.isFinite(diffMs)) return null;
    const totalHours = Math.max(0, Math.floor(diffMs / 3600000));
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return `${days}D:${hours}h`;
}

function formatCompactCacheAge(cachedAt: number): string {
    const ageMin = Math.max(0, Math.floor((Date.now() - cachedAt) / 60000));
    if (ageMin < 60) return `${ageMin}m`;
    const ageHours = Math.floor(ageMin / 60);
    if (ageHours < 24) return `${ageHours}h`;
    return `${Math.floor(ageHours / 24)}d`;
}

function formatCompactDataAge(entry: ProfileUsageEntry): string[] {
    const windows = [
        entry.fiveHourPercent == null || entry.fiveHourCachedAt == null
            ? null
            : { label: '5h', cachedAt: entry.fiveHourCachedAt },
        entry.sevenDayPercent == null || entry.sevenDayCachedAt == null
            ? null
            : { label: '7d', cachedAt: entry.sevenDayCachedAt },
    ].filter((window): window is { label: string; cachedAt: number } => window !== null);
    if (windows.length === 0) {
        return entry.cachedAt == null
            ? []
            : [`${entry.stale ? '缓' : '取'}${formatCompactCacheAge(entry.cachedAt)}`];
    }
    const first = windows[0];
    const sameSource = windows.every(window => window.cachedAt === first.cachedAt);
    if (sameSource) {
        return [`${entry.stale ? '缓' : '取'}${formatCompactCacheAge(first.cachedAt)}`];
    }
    return windows.map(window => {
        const carried = entry.cachedAt != null && window.cachedAt < entry.cachedAt;
        return `${window.label}${entry.stale || carried ? '缓' : '取'}${formatCompactCacheAge(window.cachedAt)}`;
    });
}

function formatCompactUsage(entry: ProfileUsageEntry | undefined): string[] {
    if (!entry) return ['用量未知'];
    const parts: string[] = [];
    const hasObservedUsage = entry.cachedAt != null || entry.summary != null;
    if (entry.fiveHourPercent != null) {
        parts.push(`5h:${entry.fiveHourPercent.toFixed(0)}%`);
        if (entry.full) {
            const resetText = formatCompactResetTime(entry.fiveHourResetAt);
            if (resetText) parts.push(resetText);
        }
    } else if (hasObservedUsage) {
        parts.push('5h:未知');
    }
    if (entry.sevenDayPercent != null) {
        parts.push(`7d:${entry.sevenDayPercent.toFixed(0)}%`);
        const resetText = formatCompactSevenDayResetTime(entry.sevenDayResetAt);
        if (resetText) parts.push(resetText);
    } else if (hasObservedUsage) {
        parts.push('7d:未知');
    }
    if (parts.length === 0 && entry.summary) parts.push(entry.summary);
    parts.push(...formatCompactDataAge(entry));
    return parts.length > 0 ? parts : ['用量未知'];
}

function isGuessAvailableAfterReset(entry: ProfileUsageEntry | undefined): boolean {
    if (!entry || (!entry.full && !entry.sevenDayFull)) return false;
    return !isFiveHourBlocked(entry) && !isSevenDayBlocked(entry);
}

function profileOptionLabel(name: string, status: string, entry: ProfileUsageEntry | undefined, isDefault: boolean, isCurrent: boolean): string {
    const parts = [name, profileMarker(isDefault, status, entry)];
    if (isCurrent) parts.push('当前');
    if (status) parts.push('异常');
    if (entry?.authExpired) parts.push('过期');
    parts.push(...formatCompactUsage(entry));
    return parts.filter(Boolean).join('｜');
}

function availablePercent(entry: ProfileUsageEntry | undefined): number | null {
    if (entry?.fiveHourPercent == null) return null;
    return Math.max(0, 100 - entry.fiveHourPercent);
}

function resetPassed(resetsAt: string | null | undefined): boolean {
    if (!resetsAt) return false;
    const resetAt = new Date(resetsAt).getTime();
    return Number.isFinite(resetAt) && resetAt <= Date.now();
}

function isFiveHourBlocked(entry: ProfileUsageEntry | undefined): boolean {
    return !!entry?.full && !resetPassed(entry.fiveHourResetAt);
}

function isSevenDayBlocked(entry: ProfileUsageEntry | undefined): boolean {
    return !!entry?.sevenDayFull && !resetPassed(entry.sevenDayResetAt);
}

function resetTimeDelayMs(resetsAt: string | null | undefined): number | null {
    if (!resetsAt) return null;
    const resetAt = new Date(resetsAt).getTime();
    if (!Number.isFinite(resetAt)) return null;
    return Math.max(0, resetAt - Date.now());
}

function resetDelayMs(entry: ProfileUsageEntry | undefined): number | null {
    if (!entry) return null;
    const delays: number[] = [];
    if (entry.full && !resetPassed(entry.fiveHourResetAt)) {
        const delay = resetTimeDelayMs(entry.fiveHourResetAt);
        if (delay == null) return null;
        delays.push(delay);
    }
    if (entry.sevenDayFull && !resetPassed(entry.sevenDayResetAt)) {
        const delay = resetTimeDelayMs(entry.sevenDayResetAt);
        if (delay == null) return null;
        delays.push(delay);
    }
    return delays.length > 0 ? Math.max(...delays) : null;
}

function unavailableDayMarker(delayMs: number | null): string | null {
    if (delayMs == null) return null;
    const days = Math.max(0, Math.min(5, Math.floor(delayMs / 86400000)));
    return UNAVAILABLE_DAY_MARKERS[days];
}

function unavailablePrefix(entry: ProfileUsageEntry | undefined): string | null {
    const marker = unavailableDayMarker(resetDelayMs(entry));
    if (!marker) return null;
    if (isSevenDayBlocked(entry)) return `${UNAVAILABLE_PROFILE_MARKER} ${marker}`;
    if (isFiveHourBlocked(entry)) return marker;
    return marker;
}

function profileOptionSort(status: string, entry: ProfileUsageEntry | undefined): { sortGroup: number; sortValue: number } {
    const unavailable = isProfileUnavailable(status, entry);
    if (!unavailable) {
        const available = availablePercent(entry);
        return available == null
            ? { sortGroup: 1, sortValue: 0 }
            : { sortGroup: 0, sortValue: -available };
    }

    const delay = resetDelayMs(entry);
    return delay == null
        ? { sortGroup: 3, sortValue: Number.POSITIVE_INFINITY }
        : { sortGroup: 2, sortValue: delay };
}

function stripOptionInfo(value: string): string {
    return value.split(/[｜|]/, 1)[0].trim();
}

function menuOptionText(option: ProfileOptionSuggestion): string {
    const labelParts = option.label.split(OPTION_INFO_SEPARATOR);
    const detailParts = labelParts[0] === option.name ? labelParts.slice(1) : labelParts;
    const markerIndex = detailParts.findIndex(isProfileMarker);
    const marker = markerIndex === -1 ? null : detailParts.splice(markerIndex, 1)[0];
    const commandText = marker ? `${marker} ${option.value}` : option.value;
    const detail = detailParts.join(OPTION_INFO_SEPARATOR);
    return detail ? `${commandText}${OPTION_INFO_SEPARATOR}${detail}` : commandText;
}

function disabledInfoText(option: ProfileOptionSuggestion): string {
    const text = option.label
        .split(OPTION_INFO_SEPARATOR)
        .filter(part => !isProfileMarker(part) && part !== '满' && part !== '猜')
        .join(OPTION_INFO_SEPARATOR);
    return option.unavailablePrefix ? `${option.unavailablePrefix} ${text}` : text;
}

function isProfileMarker(part: string): boolean {
    return part === LEGACY_DEFAULT_PROFILE_MARKER
        || part === DEFAULT_PROFILE_MARKER
        || part === DEFAULT_HIGH_USAGE_PROFILE_MARKER
        || part === USABLE_PROFILE_MARKER
        || part === UNAVAILABLE_PROFILE_MARKER
        || part === GUESS_AVAILABLE_PROFILE_MARKER;
}

function buildProfileOptions(
    profiles: CcsProfileInfo[],
    usageMap: Map<string, ProfileUsageEntry>,
    opts: {
        command: '@a' | '@aa' | '@aa-codex';
        currentProfile?: string | null;
        defaultProfile?: string | null;
        flavor: AuthFlavor;
        codexNames?: Set<string>;
    }
): ProfileOptionSuggestion[] {
    return profiles
        .map(profile => {
            const entry = usageMap.get(profile.name);
            const status = getProfileStatus(profile, opts.flavor, opts.codexNames);
            const isCurrent = profile.name === opts.currentProfile;
            const unavailable = isProfileUnavailable(status, entry);
            const disabled = isCurrent || unavailable;
            const sort = profileOptionSort(status, entry);
            return {
                label: profileOptionLabel(profile.name, status, entry, profile.name === opts.defaultProfile, isCurrent),
                value: `${opts.command} ${profile.name}`.trim(),
                disabled,
                unavailableDelayMs: unavailable ? resetDelayMs(entry) : null,
                unavailablePrefix: unavailable ? unavailablePrefix(entry) : null,
                ...sort,
                name: profile.name,
            };
        })
        .sort((a, b) => a.sortGroup - b.sortGroup || a.sortValue - b.sortValue || a.name.localeCompare(b.name));
}

function buildLegacyProfileListResult(options: ReturnType<typeof buildProfileOptions>, flavorLabel: string): BangCommandResult {
    const enabled = options.filter(option => !option.disabled);
    const disabled = options.filter(option => option.disabled);
    const result: BangCommandResult = {
        message: `请选择要切换的 ${flavorLabel} 账户：`,
        action: 'none',
    };
    if (enabled.length > 0) result.suggestions = enabled.map(menuOptionText);
    if (disabled.length === 0) return result;
    return {
        ...result,
        afterSuggestionsMessage: ['不可用：', ...disabled.map(disabledInfoText)].join('\n'),
    };
}

async function listProfiles(isConsole: boolean, flavor: AuthFlavor = 'claude'): Promise<BangCommandResult> {
    const { profiles: ccsProfiles, defaultProfile: claudeDefault } = readCcsProfiles();
    const codexProfiles = flavor === 'codex' ? readCodexProfiles() : [];

    if (flavor === 'codex' && codexProfiles.length === 0) {
        return { message: '❌ 未找到已登录的 Codex 账户。', action: 'none' };
    }

    const profiles: CcsProfileInfo[] = flavor === 'codex'
        ? codexToCcsProfiles(codexProfiles)
        : ccsProfiles;

    const codexNames = flavor === 'codex' ? new Set(codexProfiles.map(p => p.name)) : undefined;
    const codexDefault = flavor === 'codex' ? readCodexDefaultProfile() : null;
    const configuredDefault = flavor === 'codex' ? codexDefault : claudeDefault;
    const defaultProfile = isConsole
        ? readAccountIntent(flavor === 'codex' ? 'codex' : 'claude')?.profileName ?? configuredDefault
        : configuredDefault;

    const flavorLabel = flavor === 'codex' ? 'Codex' : 'Claude';

    // Console: currentProfile is always null (CLAUDE_CONFIG_DIR never set in console process).
    if (isConsole) {
        if (profiles.length === 0) {
            return { message: `❌ 未找到 CCS 配置。(${flavorLabel})`, action: 'none' };
        }
        const profileNames = profiles.map(p => p.name);
        const usageMap = await loadConsoleUsageSummaries(profileNames, flavor);
        const suggestions = buildProfileOptions(profiles, usageMap, {
            command: flavor === 'codex' ? '@aa-codex' : '@aa',
            defaultProfile,
            flavor,
            codexNames,
        });
        return buildLegacyProfileListResult(suggestions, flavorLabel);
    }

    const currentProfile = getCurrentProfileForFlavor(flavor);

    // Normal session not launched via CCS — no current profile to anchor on.
    if (!currentProfile) {
        if (profiles.length > 0) {
            const profileNames = profiles.map(p => p.name);
            const usageMap = readCachedUsageSummaries(profileNames, flavor);
            await refreshMissingCodexUsageSummaries(profileNames, flavor, usageMap);
            const suggestions = buildProfileOptions(profiles, usageMap, {
                command: '@a',
                defaultProfile,
                flavor,
                codexNames,
            });
            return buildLegacyProfileListResult(suggestions, flavorLabel);
        }
        return { message: `❌ 未找到 CCS 配置。(${flavorLabel})`, action: 'none' };
    }

    const profileNames = profiles.map(p => p.name);
    const usageMap = readCachedUsageSummaries(profileNames, flavor);
    await refreshMissingCodexUsageSummaries(profileNames, flavor, usageMap);
    const suggestions = buildProfileOptions(profiles, usageMap, {
        command: '@a',
        currentProfile,
        defaultProfile,
        flavor,
        codexNames,
    });
    return buildLegacyProfileListResult(suggestions, flavorLabel);
}

function switchProfile(
    profileName: string,
    flavor: AuthFlavor = 'claude',
    deferCodexProfileSwitch = false,
    ctx?: BangCommandContext,
): BangCommandResult {
    profileName = stripOptionInfo(profileName);
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

    const globalSetAt = readAccountIntent(flavor === 'codex' ? 'codex' : 'claude')?.setAt ?? 0;
    const happySessionId = ((ctx?.client as unknown as { sessionId?: string })?.sessionId ?? '').trim();
    const markManualChoice = (): string | null => {
        if (!happySessionId) return null;
        try {
            writeSessionAccountSelection(
                happySessionId,
                flavor === 'codex' ? 'codex' : 'claude',
                profileName,
                globalSetAt,
            );
            return null;
        } catch (error) {
            logger.warn('[!auth] Failed to preserve the manual account choice:', error);
            return '⚠ 当前账号已切换，但持久标记写入失败；下次输入会重新核对全局账号';
        }
    };

    // Check if already on this profile. A manual selection still consumes the
    // current global setting so the session remains pinned until a newer one.
    if (target.name === currentProfile) {
        const warning = markManualChoice();
        return {
            message: warning ? [`✅ 当前已是 "${profileName}"`, warning] : `✅ 当前已是 "${profileName}"`,
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

    const deferred = flavor === 'codex' && deferCodexProfileSwitch;
    if (!deferred) {
        applyProfileSwitch(profileName, flavor, target.instancePath);
    }

    const usageLine = flavor !== 'codex' ? getCachedUsageSummary(target.instancePath) : null;
    const messages = [deferred
        ? `⏳ 正在切换到 "${profileName}"`
        : `✅ 已切换到 "${profileName}"`];
    if (!deferred) {
        const warning = markManualChoice();
        if (warning) messages.push(warning);
    }
    if (usageLine) messages.push(usageLine);
    return {
        message: messages,
        action: 'restart-session',
        ...(deferred ? { restartProfile: profileName } : {}),
        ...(deferred ? { restartSeenGlobalSetAt: globalSetAt } : {}),
    };
}

/**
 * Record the account selected for the machine. Sessions compare its monotonic
 * timestamp immediately before their next real input; no process is broadcast,
 * interrupted, restarted or woken by this write.
 */
function switchAllProfiles(profileName: string, flavor: AuthFlavor = 'claude'): BangCommandResult {
    profileName = stripOptionInfo(profileName);
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

    try {
        publishAccountIntent(flavor === 'codex' ? 'codex' : 'claude', profileName);
        logger.debug(`[!auth] Recorded global account intent (${flavor}): ${profileName}`);
    } catch (err) {
        logger.debug('[!auth] Failed to write global account intent:', err);
        return {
            message: ['❌ 全局账号设置失败'],
            action: 'none',
        };
    }

    const usageLine = getCachedUsageSummary(target.instancePath);
    const messages = [
        `✅ 全局账号已设置为 "${profileName}"`,
        '现有会话不会被打断，将在下一次实际输入前核对并切换',
    ];
    if (usageLine) messages.push(usageLine);
    return { message: messages, action: 'none' };
}
