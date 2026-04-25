/**
 * Codex rollout file discovery.
 *
 * Codex CLI persists each conversation to ~/.codex/sessions/YYYY/MM/DD/
 * rollout-<TS>-<conversationId>.jsonl as an append-only jsonl. The filename's
 * trailing UUID is the conversationId we get from `thread/start` responses.
 *
 * Used by /compact: given the active codex threadId, find the rollout file so
 * we can read the full conversation locally and build a heuristic seed without
 * touching the network.
 */

import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';

const UUID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function getDefaultCodexSessionsRoot(): string {
    const codexHome = process.env.CODEX_HOME;
    if (codexHome && codexHome.trim().length > 0) {
        return join(codexHome, 'sessions');
    }
    return join(homedir(), '.codex', 'sessions');
}

export function parseConversationIdFromRolloutFilename(filePath: string): string | null {
    const match = UUID_RE.exec(filePath);
    return match ? match[1].toLowerCase() : null;
}

/**
 * Scan sessions root (YYYY/MM/DD layout) and find the rollout file whose
 * filename ends with the given conversationId.
 *
 * Returns null if no match is found. Walks newest-first (descending YYYY/MM/DD)
 * so common cases (recent conversations) terminate quickly.
 */
export async function findRolloutByConversationId(
    sessionsRoot: string,
    conversationId: string,
): Promise<string | null> {
    const target = conversationId.trim().toLowerCase();
    if (!target) return null;

    return scan(sessionsRoot, 0, target);
}

async function scan(dir: string, depth: number, target: string): Promise<string | null> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
        // Missing directory is normal at deeper levels (no sessions on that day)
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.debug(`[rolloutDiscovery] readdir failed at ${dir}: ${(err as Error).message}`);
        }
        return null;
    }

    if (depth >= 3) {
        // File layer — look for matching filename
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (!entry.name.startsWith('rollout-')) continue;
            if (!entry.name.endsWith('.jsonl')) continue;
            const id = parseConversationIdFromRolloutFilename(entry.name);
            if (id === target) {
                return join(dir, entry.name);
            }
        }
        return null;
    }

    // Directory layer — descend newest-first (lexicographic descending matches
    // YYYY/MM/DD numeric ordering for valid 4/2/2-digit folder names).
    const subdirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => /^\d+$/.test(name))
        .sort()
        .reverse();

    for (const sub of subdirs) {
        const found = await scan(join(dir, sub), depth + 1, target);
        if (found) return found;
    }
    return null;
}
