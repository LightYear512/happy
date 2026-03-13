import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { logger } from '@/ui/logger';
import { readCcsProfiles, getCurrentCcsProfile, type CcsProfileInfo } from './ccsProfiles';
import { configuration } from '@/configuration';
import type { BangCommandContext, BangCommandResult } from './types';

/**
 * Handle the `!auth` bang command.
 *
 * - `!auth` — List available CCS profiles with current active indicator
 * - `!auth <name>` — Switch current session to the specified profile
 * - `!auth all <name>` — Switch all sessions on this machine to the specified profile
 */
export async function handleAuthBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const trimmed = args.trim();

    if (!trimmed) {
        return listProfiles();
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
            logger.debug(`[!auth] Global switch: instance path not found for "${profileName}"`);
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

function listProfiles(): BangCommandResult {
    const { profiles } = readCcsProfiles();
    const currentProfile = getCurrentCcsProfile();
    const currentProfileInfo = currentProfile
        ? profiles.find(p => p.name === currentProfile) ?? null
        : null;

    const lines: string[] = [];

    // No active CCS profile (session not started via CCS)
    if (!currentProfile) {
        lines.push('📋 No CCS profile active.');
        lines.push('');
        if (profiles.length > 0) {
            lines.push('Available profiles:');
            for (const p of profiles) {
                lines.push(`  ○ ${p.name}`);
            }
        } else {
            lines.push('No CCS profiles configured.');
        }
        return { message: lines.join('\n'), action: 'none' };
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
        lines.push(`📋 Group "${currentGroup}":`);
    } else {
        lines.push(`📋 Account: ${currentProfile} (isolated)`);
    }

    lines.push('');
    lines.push(`  ● ${currentProfile} (current)`);

    if (currentGroup && switchable.length > 0) {
        for (const profile of switchable) {
            lines.push(`  ○ ${profile.name}`);
        }
        lines.push('');
        lines.push('Switch: !auth <name> (this session) | !auth all <name> (all sessions)');
    } else if (currentGroup) {
        lines.push('');
        lines.push('No other accounts in this group.');
    } else {
        lines.push('');
        lines.push('Isolated mode — switching is not available.');
    }

    return { message: lines.join('\n'), action: 'none' };
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
            message: `❌ Profile "${profileName}" not found. Use !auth to see available accounts.`,
            action: 'none',
        };
    }

    // Check if already on this profile
    if (target.name === currentProfile) {
        return {
            message: `✅ Already using "${profileName}".`,
            action: 'none',
        };
    }

    // Only allow switching within the same shared context group
    const currentProfileInfo = currentProfile
        ? profiles.find(p => p.name === currentProfile) ?? null
        : null;

    if (!isSharedContext(currentProfileInfo, target)) {
        const describeMode = (p: CcsProfileInfo | null): string =>
            !p || p.contextMode !== 'shared' ? 'isolated' : `group "${p.contextGroup || 'default'}"`;
        return {
            message: `❌ Cannot switch: "${currentProfile || 'unknown'}" is ${describeMode(currentProfileInfo)}, "${profileName}" is ${describeMode(target)}.`,
            action: 'none',
        };
    }

    // Verify instance directory exists
    if (!existsSync(target.instancePath)) {
        return {
            message: `❌ Profile "${profileName}" instance not initialized.`,
            action: 'none',
        };
    }

    // Perform the switch — shared context, no session reset needed
    process.env.CLAUDE_CONFIG_DIR = target.instancePath;
    logger.debug(`[!auth] Switched CLAUDE_CONFIG_DIR to: ${target.instancePath}`);

    return {
        message: `✅ Switched to "${profileName}".`,
        action: 'restart-session',
    };
}

/**
 * Switch all sessions on this machine to the specified profile.
 * Validates and switches the current session, then writes the profile name
 * to a global file so other sessions pick it up via fs.watch.
 */
function switchAllProfiles(profileName: string): BangCommandResult {
    // Validate and switch current session first (reuses all switchProfile checks)
    const result = switchProfile(profileName);
    if (result.action !== 'restart-session') {
        return result; // Validation failed — return the error message as-is
    }

    // Write to global file so other sessions detect the change via fs.watch
    try {
        writeFileSync(configuration.activeProfileFile, profileName, 'utf-8');
        logger.debug(`[!auth] Wrote global active profile: ${profileName}`);
    } catch (err) {
        logger.debug('[!auth] Failed to write global profile file:', err);
        return {
            message: `⚠️ Switched to "${profileName}" locally, but failed to broadcast to other sessions.`,
            action: 'restart-session',
        };
    }

    return {
        message: `✅ Switched all sessions to "${profileName}".`,
        action: 'restart-session',
    };
}
