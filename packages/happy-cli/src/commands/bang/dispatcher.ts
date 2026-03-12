import { logger } from '@/ui/logger';
import { handleAuthBangCommand } from './authCommand';
import type { BangCommandContext, BangCommandHandler, BangCommandResult } from './types';

/**
 * Registry of bang commands.
 * Add new commands here to make them available via `!<name>` from the mobile chat.
 */
const commands: Record<string, BangCommandHandler> = {
    auth: handleAuthBangCommand,
};

/**
 * Check if a message is a bang command (starts with `!`).
 */
export function isBangCommand(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.startsWith('!') && trimmed.length > 1 && trimmed[1] !== ' ';
}

/**
 * Parse a bang command into its name and arguments.
 */
function parseBangCommand(text: string): { name: string; args: string } {
    const trimmed = text.trim();
    // Remove leading `!`
    const body = trimmed.slice(1);
    const spaceIndex = body.indexOf(' ');

    if (spaceIndex === -1) {
        return { name: body.toLowerCase(), args: '' };
    }

    return {
        name: body.slice(0, spaceIndex).toLowerCase(),
        args: body.slice(spaceIndex + 1),
    };
}

/**
 * Execute a bang command. Returns null if the command is not recognized.
 */
export async function executeBangCommand(text: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const { name, args } = parseBangCommand(text);
    logger.debug(`[bang] Executing command: !${name} args="${args}"`);

    const handler = commands[name];

    if (!handler) {
        const available = Object.keys(commands).map(c => `!${c}`).join(', ');
        return {
            message: `❌ Unknown command "!${name}".\n\nAvailable commands: ${available}`,
            action: 'none',
        };
    }

    try {
        return await handler(args, ctx);
    } catch (error) {
        logger.debug(`[bang] Command !${name} failed:`, error);
        return {
            message: `❌ Command !${name} failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            action: 'none',
        };
    }
}
