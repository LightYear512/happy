/**
 * `!sessions` bang command — List recoverable Claude Code sessions.
 *
 * Scans ~/.claude/projects/ for JSONL session files and displays them
 * sorted by recency, with short IDs for use with `!resume`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, stat, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { logger } from '@/ui/logger';
import { SEPARATOR, type BangCommandContext, type BangCommandResult } from './types';

/** Represents a discovered Claude session file */
export interface ClaudeSessionInfo {
    /** Full Claude session ID (UUID) */
    sessionId: string;
    /** Hashed project directory name (e.g., "C--Users-xuhao") */
    projectDir: string;
    /** Resolved working directory from JSONL content, if found */
    cwd: string | null;
    /** Last modification time */
    mtime: Date;
    /** First user message preview */
    firstMessage: string | null;
}

/** Max sessions to display */
const MAX_DISPLAY = 15;

/** Short ID length for display */
const SHORT_ID_LEN = 8;

/**
 * Scan all Claude project directories for JSONL session files.
 * Returns sessions sorted by most recent first.
 */
export async function scanClaudeSessions(): Promise<ClaudeSessionInfo[]> {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const projectsDir = join(claudeConfigDir, 'projects');

    if (!existsSync(projectsDir)) {
        logger.debug(`[!sessions] Projects directory not found: ${projectsDir}`);
        return [];
    }

    const sessions: ClaudeSessionInfo[] = [];

    try {
        const projectDirs = await readdir(projectsDir, { withFileTypes: true });

        for (const dir of projectDirs) {
            if (!dir.isDirectory()) continue;

            const dirPath = join(projectsDir, dir.name);

            try {
                const files = await readdir(dirPath);
                const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

                for (const file of jsonlFiles) {
                    const sessionId = file.replace('.jsonl', '');
                    const filePath = join(dirPath, file);

                    try {
                        const fileStat = await stat(filePath);

                        // Skip tiny files (likely empty/corrupt)
                        if (fileStat.size < 50) continue;

                        // Read first few lines to extract cwd and first user message
                        const { cwd, firstMessage } = await extractSessionPreview(filePath);

                        sessions.push({
                            sessionId,
                            projectDir: dir.name,
                            cwd,
                            mtime: fileStat.mtime,
                            firstMessage,
                        });
                    } catch (err) {
                        logger.debug(`[!sessions] Failed to stat ${filePath}:`, err);
                    }
                }
            } catch (err) {
                logger.debug(`[!sessions] Failed to read project dir ${dirPath}:`, err);
            }
        }
    } catch (err) {
        logger.debug(`[!sessions] Failed to read projects directory:`, err);
    }

    // Sort by most recent first
    sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return sessions;
}

/**
 * Read the first few lines of a JSONL file to extract cwd and first user message.
 */
async function extractSessionPreview(filePath: string): Promise<{ cwd: string | null; firstMessage: string | null }> {
    let cwd: string | null = null;
    let firstMessage: string | null = null;

    const handle = await open(filePath, 'r');
    try {
        // Read only first 8KB — avoid loading multi-MB session files into memory
        const buffer = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(buffer, 0, 8192, 0);
        const chunk = buffer.toString('utf-8', 0, bytesRead);
        const lines = chunk.split('\n').filter(l => l.trim().length > 0);

        for (const line of lines.slice(0, 10)) {
            try {
                const obj = JSON.parse(line);

                // Extract cwd from any line that has it
                if (!cwd && obj.cwd) {
                    cwd = obj.cwd;
                }

                // Extract first user message content
                if (!firstMessage && obj.type === 'queue-operation' && obj.operation === 'enqueue' && obj.content) {
                    firstMessage = typeof obj.content === 'string' ? obj.content : null;
                }

                // Also check for user messages in the standard format
                if (!firstMessage && obj.message?.role === 'user') {
                    const content = obj.message.content;
                    if (typeof content === 'string') {
                        firstMessage = content;
                    } else if (Array.isArray(content)) {
                        const textBlock = content.find((c: any) => c.type === 'text');
                        if (textBlock) firstMessage = textBlock.text;
                    }
                }

                if (cwd && firstMessage) break;
            } catch {
                // Skip unparseable lines
            }
        }
    } finally {
        await handle.close();
    }

    return { cwd, firstMessage };
}

/**
 * Format relative time from a Date to now.
 */
function relativeTime(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    const diffHour = Math.floor(diffMs / 3_600_000);
    const diffDay = Math.floor(diffMs / 86_400_000);

    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin}分钟前`;
    if (diffHour < 24) return `${diffHour}小时前`;
    if (diffDay < 30) return `${diffDay}天前`;
    return `${Math.floor(diffDay / 30)}月前`;
}

/**
 * Handle the `!sessions` bang command.
 */
export async function handleSessionsBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const sessions = await scanClaudeSessions();

    if (sessions.length === 0) {
        return { message: '📭 没有找到可恢复的会话', action: 'none' };
    }

    const displayed = sessions.slice(0, MAX_DISPLAY);
    const messages: string[] = [
        `📋 可恢复的会话 (${Math.min(sessions.length, MAX_DISPLAY)}/${sessions.length})`,
        SEPARATOR,
    ];

    for (const s of displayed) {
        const shortId = s.sessionId.slice(0, SHORT_ID_LEN);
        const time = relativeTime(s.mtime);
        const dir = s.cwd ? s.cwd.split(/[/\\]/).pop() || s.projectDir : s.projectDir;
        const msg = s.firstMessage ? s.firstMessage.slice(0, 35).replace(/\n/g, ' ') : '';
        const msgSuffix = s.firstMessage && s.firstMessage.length > 35 ? '...' : '';

        const sessionLine = msg
            ? `${shortId} | ${dir} | ${time}\n  "${msg}${msgSuffix}"`
            : `${shortId} | ${dir} | ${time}`;
        messages.push(sessionLine);
    }

    messages.push(SEPARATOR);
    messages.push('用法: !resume <id前缀>');

    return { message: messages, action: 'none' };
}
