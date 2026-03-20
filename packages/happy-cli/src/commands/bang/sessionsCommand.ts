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
import { configuration } from '@/configuration';
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
    /** Session preview: happy_title or last user message */
    preview: string | null;
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

                        const { cwd, preview } = await extractSessionPreview(filePath, fileStat.size);

                        sessions.push({
                            sessionId,
                            projectDir: dir.name,
                            cwd,
                            mtime: fileStat.mtime,
                            preview,
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

    // Filter out console sessions (cwd is ~/.happy/console or similar)
    const consoleDir = join(configuration.happyHomeDir, 'console').replace(/\\/g, '/');
    const filtered = sessions.filter(s => {
        if (!s.cwd) return true;
        const normalised = s.cwd.replace(/\\/g, '/');
        return !normalised.startsWith(consoleDir);
    });

    // Sort by most recent first
    filtered.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return filtered;
}

/** Size of chunks to read from head/tail of session files */
const READ_CHUNK = 8192;

/**
 * Extract a user message from a parsed JSONL object.
 * Returns null for system-injected messages (starting with <).
 */
function extractUserMessage(obj: any): string | null {
    // queue-operation enqueue format
    if (obj.type === 'queue-operation' && obj.operation === 'enqueue' && obj.content) {
        if (typeof obj.content === 'string' && !obj.content.trimStart().startsWith('<')) {
            return obj.content;
        }
    }
    // Standard user message format
    if (obj.message?.role === 'user') {
        const content = obj.message.content;
        let text: string | null = null;
        if (typeof content === 'string') {
            text = content;
        } else if (Array.isArray(content)) {
            const textBlock = content.find((c: any) => c.type === 'text');
            if (textBlock) text = textBlock.text;
        }
        if (text && !text.trimStart().startsWith('<')) return text;
    }
    return null;
}

/**
 * Read session file to extract cwd (from head) and preview (from tail).
 * Preview priority: last happy_title > last user message.
 */
async function extractSessionPreview(filePath: string, fileSize: number): Promise<{ cwd: string | null; preview: string | null }> {
    let cwd: string | null = null;
    let preview: string | null = null;

    const handle = await open(filePath, 'r');
    try {
        // --- Head: extract cwd from first few lines ---
        const headBuf = Buffer.alloc(READ_CHUNK);
        const { bytesRead: headRead } = await handle.read(headBuf, 0, READ_CHUNK, 0);
        const headLines = headBuf.toString('utf-8', 0, headRead).split('\n').filter(l => l.trim().length > 0);

        for (const line of headLines.slice(0, 10)) {
            try {
                const obj = JSON.parse(line);
                if (obj.cwd) { cwd = obj.cwd; break; }
            } catch { /* skip */ }
        }

        // --- Tail: find last happy_title or last user message ---
        const tailOffset = Math.max(0, fileSize - READ_CHUNK);
        const tailBuf = Buffer.alloc(READ_CHUNK);
        const { bytesRead: tailRead } = await handle.read(tailBuf, 0, READ_CHUNK, tailOffset);
        const tailChunk = tailBuf.toString('utf-8', 0, tailRead);
        // If reading from middle of file, skip first partial line
        const tailLines = tailOffset > 0
            ? tailChunk.slice(tailChunk.indexOf('\n') + 1).split('\n').filter(l => l.trim().length > 0)
            : tailChunk.split('\n').filter(l => l.trim().length > 0);

        let lastUserMsg: string | null = null;

        for (const line of tailLines) {
            try {
                const obj = JSON.parse(line);
                if (obj.type === 'happy_title' && obj.title) {
                    preview = obj.title;
                }
                const msg = extractUserMessage(obj);
                if (msg) lastUserMsg = msg;
            } catch { /* skip */ }
        }

        // Fallback: title > last user message
        if (!preview) preview = lastUserMsg;
    } finally {
        await handle.close();
    }

    return { cwd, preview };
}

/** Separator bar character */
const BAR = '━';

/** Fixed separator length appended after time group labels */
const GROUP_BAR_LEN = 19;

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
 * Determine the time group label for a session.
 */
function timeGroupLabel(date: Date): string {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86_400_000);
    const sessionDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (sessionDay.getTime() >= today.getTime()) return '今天';
    if (sessionDay.getTime() >= yesterday.getTime()) return '昨天';

    const diffDay = Math.floor((today.getTime() - sessionDay.getTime()) / 86_400_000);
    if (diffDay < 7) return `${diffDay}天前`;
    if (diffDay < 30) return `${Math.floor(diffDay / 7)}周前`;
    return `${Math.floor(diffDay / 30)}月前`;
}

/**
 * Shorten a path for display: last segment, or ~ if it's the home directory itself.
 */
function shortenPath(fullPath: string): string {
    const home = homedir().replace(/\\/g, '/');
    const normalised = fullPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalised === home) return '~';
    return normalised.split('/').pop() || normalised;
}

/**
 * Handle the `!sessions` bang command.
 */
export async function handleSessionsBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const rawFilter = args.trim() || null;
    const dirFilter = rawFilter
        ? rawFilter.replace(/^~/, homedir()).replace(/\\/g, '/').toLowerCase()
        : null;
    let sessions = await scanClaudeSessions();

    if (dirFilter) {
        sessions = sessions.filter(s => {
            const dir = s.cwd ? s.cwd.replace(/\\/g, '/') : s.projectDir;
            return dir.toLowerCase().includes(dirFilter);
        });
    }

    if (sessions.length === 0) {
        const hint = dirFilter ? ` (筛选: "${dirFilter}")` : '';
        return { message: `📭 没有找到可恢复的会话${hint}`, action: 'none' };
    }

    const displayed = sessions.slice(0, MAX_DISPLAY);
    const countLabel = `${Math.min(sessions.length, MAX_DISPLAY)}/${sessions.length}`;
    const filterLabel = rawFilter ? ` · 筛选: "${rawFilter}"` : '';
    const messages: string[] = [
        `📋 可恢复的会话 (${countLabel}${filterLabel})`,
    ];

    let currentGroup = '';

    for (const s of displayed) {
        const group = timeGroupLabel(s.mtime);
        if (group !== currentGroup) {
            currentGroup = group;
            messages.push(`▸ ${group} ${BAR.repeat(GROUP_BAR_LEN)}`);
        }

        const shortId = s.sessionId.slice(0, SHORT_ID_LEN);
        const time = relativeTime(s.mtime);
        const dir = s.cwd ? shortenPath(s.cwd) : s.projectDir;
        const cleanMsg = s.preview ? s.preview.replace(/\n/g, ' ').trim() : '';
        const msg = cleanMsg.slice(0, 35);
        const msgSuffix = cleanMsg.length > 35 ? '…' : '';

        const sessionLine = msg
            ? `  [${shortId}] ${dir} · ${time} — ${msg}${msgSuffix}`
            : `  [${shortId}] ${dir} · ${time}`;
        messages.push(sessionLine);
    }

    messages.push('');
    messages.push('💡 !resume <id前缀>');

    return { message: messages, action: 'none' };
}
