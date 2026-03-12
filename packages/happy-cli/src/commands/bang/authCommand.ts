import { existsSync } from 'node:fs';
import { logger } from '@/ui/logger';
import { readCcsProfiles, getCurrentCcsProfile, type CcsProfileInfo } from './ccsProfiles';
import type { BangCommandContext, BangCommandResult } from './types';

/**
 * Handle the `!auth` bang command.
 *
 * - `!auth` — List available CCS profiles with current active indicator
 * - `!auth <name>` — Switch to the specified profile
 */
export async function handleAuthBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const profileName = args.trim();

    if (!profileName) {
        return listProfiles();
    }

    return switchProfile(profileName, ctx);
}

function listProfiles(): BangCommandResult {
    const { profiles } = readCcsProfiles();
    const currentProfile = getCurrentCcsProfile();
    const currentProfileInfo = currentProfile
        ? profiles.find(p => p.name === currentProfile) ?? null
        : null;

    const currentName = currentProfile || 'default';
    const isShared = currentProfileInfo?.contextMode === 'shared';
    const currentGroup = isShared ? (currentProfileInfo.contextGroup || 'default') : null;

    // Find other profiles in the same shared group
    const switchable = currentGroup
        ? profiles.filter(p =>
            p.contextMode === 'shared'
            && (p.contextGroup || 'default') === currentGroup
            && p.name !== currentProfile)
        : [];

    const lines: string[] = [];

    if (currentGroup) {
        lines.push(`📋 Group "${currentGroup}":`);
    } else {
        lines.push(`📋 Account: ${currentName} (isolated)`);
    }

    lines.push('');

    if (!currentGroup || switchable.length === 0) {
        lines.push(`  ● ${currentName} (current)`);
        lines.push('');
        lines.push('No switchable accounts.');
    } else {
        lines.push(`  ● ${currentName} (current)`);
        for (const profile of switchable) {
            lines.push(`  ○ ${profile.name}`);
        }
        lines.push('');
        lines.push('Switch: !auth <name>');
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

function switchProfile(profileName: string, _ctx: BangCommandContext): BangCommandResult {
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
        return {
            message: `❌ Cannot switch to "${profileName}" — not in the same context group.`,
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
        action: 'none',
    };
}
