import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getProjectPath(workingDirectory: string) {
    let resolved = resolve(workingDirectory);
    // Strip Windows drive letter (e.g. "E:\..." → "\...") so project IDs are platform-consistent.
    resolved = resolved.replace(/^[A-Za-z]:/, '');
    const projectId = resolved.replace(/[^a-zA-Z0-9-]/g, '-');
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects', projectId);
}