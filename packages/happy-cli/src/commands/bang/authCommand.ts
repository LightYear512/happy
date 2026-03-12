import { existsSync } from 'node:fs';
import { logger } from '@/ui/logger';
import { readCcsProfiles, getCurrentCcsProfile, getInstancePath } from './ccsProfiles';
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
    const { profiles, defaultProfile } = readCcsProfiles();

    if (profiles.length === 0) {
        return {
            message: [
                '⚠️ No CCS profiles found',
                '',
                'Create profiles with:',
                '  ccs auth create <name>',
                '',
                'Use --share-context to share project context across profiles.',
            ].join('\n'),
            action: 'none',
        };
    }

    const currentProfile = getCurrentCcsProfile();
    const lines: string[] = ['📋 Available accounts:'];
    lines.push('');

    for (const profile of profiles) {
        const isCurrent = profile.name === currentProfile;
        const isDefault = profile.name === defaultProfile;
        const indicator = isCurrent ? '●' : '○';
        const currentTag = isCurrent ? ' (current)' : '';
        const defaultTag = isDefault ? ' [default]' : '';
        const contextTag = profile.contextMode === 'shared'
            ? ` [shared: ${profile.contextGroup || 'default'}]`
            : '';

        lines.push(`  ${indicator} ${profile.name}${currentTag}${defaultTag}${contextTag}`);
    }

    // Show "default Claude" entry if no profile is active
    if (!currentProfile) {
        lines.push(`  ● default (current)`);
    }

    lines.push('');
    lines.push('Switch: !auth <name>');

    return { message: lines.join('\n'), action: 'none' };
}

function switchProfile(profileName: string, ctx: BangCommandContext): BangCommandResult {
    const { profiles } = readCcsProfiles();
    const currentProfile = getCurrentCcsProfile();

    // Handle switching to "default" (unset CLAUDE_CONFIG_DIR)
    if (profileName === 'default') {
        if (!currentProfile) {
            return {
                message: '✅ Already using default Claude account.',
                action: 'none',
            };
        }

        delete process.env.CLAUDE_CONFIG_DIR;
        logger.debug(`[!auth] Switched to default profile (unset CLAUDE_CONFIG_DIR)`);

        return {
            message: '🔄 Switching to default Claude account...',
            action: 'restart-session',
        };
    }

    // Find the target profile
    const target = profiles.find(p => p.name === profileName);

    if (!target) {
        // Suggest similar names
        const suggestions = profiles
            .filter(p => p.name.includes(profileName) || profileName.includes(p.name))
            .map(p => p.name);

        const suggestionText = suggestions.length > 0
            ? `\n\nDid you mean: ${suggestions.join(', ')}?`
            : `\n\nAvailable profiles: ${profiles.map(p => p.name).join(', ')}`;

        return {
            message: `❌ Profile "${profileName}" not found.${suggestionText}`,
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

    // Verify instance directory exists
    if (!existsSync(target.instancePath)) {
        return {
            message: [
                `❌ Profile "${profileName}" instance not initialized.`,
                '',
                `Run: ccs auth create ${profileName}`,
                'to initialize the profile instance.',
            ].join('\n'),
            action: 'none',
        };
    }

    // Perform the switch
    process.env.CLAUDE_CONFIG_DIR = target.instancePath;
    logger.debug(`[!auth] Switched CLAUDE_CONFIG_DIR to: ${target.instancePath}`);

    return {
        message: `🔄 Switching to "${profileName}"...`,
        action: 'restart-session',
    };
}
