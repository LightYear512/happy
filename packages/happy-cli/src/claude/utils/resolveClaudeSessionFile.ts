import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getProjectPath } from './path';

/** Match Claude's explicit UUID resume: current project first, then one unique
 * transcript in the selected account. Never move history or select an account. */
export function resolveClaudeSessionFile(sessionId: string, workingDirectory: string): string | null {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) return null;
    const projectDir = getProjectPath(workingDirectory);
    const current = join(projectDir, `${sessionId}.jsonl`);
    try {
        if (statSync(current).isFile()) return current;
        return null;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }

    const projectsDir = dirname(projectDir);
    let match: string | null = null;
    try {
        for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const candidate = join(projectsDir, entry.name, `${sessionId}.jsonl`);
            try {
                if (!statSync(candidate).isFile()) continue;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'ENOENT' || code === 'ENOTDIR') continue;
                return null;
            }
            if (match) return null;
            match = candidate;
        }
    } catch {
        return null;
    }
    return match;
}
