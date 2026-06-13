import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '@/ui/logger';
import type { BangCommandContext } from './types';

export function findHtaskRoot(): string | null {
    let dir = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    for (;;) {
        if (existsSync(join(dir, '.agents', 'htask', 'htask.py'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

export function runHtask(root: string, args: string[], input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolveRun, reject) => {
        const child = spawn('python3', [join(root, '.agents', 'htask', 'htask.py'), ...args], {
            cwd: root,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => resolveRun({ code: code ?? 1, stdout, stderr }));
        child.stdin.end(input);
    });
}

export function currentHappyId(ctx: BangCommandContext): string {
    const clientSessionId = (ctx.client as unknown as { sessionId?: string }).sessionId;
    return (clientSessionId || process.env.HTASK_SESSION_CONFIG_ID || process.env.HAPPY_SESSION_ID || '').trim();
}

export function htaskBlock(text: string, pattern: RegExp): string | null {
    const matches = [...text.matchAll(/<htask>([\s\S]*?)<\/htask>/g)];
    for (const match of matches) {
        const block = (match[1] || '').trim();
        if (pattern.test(block)) return block;
    }
    return null;
}

export async function htaskCanonicalTitle(root: string, happyId: string, flavor: BangCommandContext['flavor']): Promise<string | null> {
    if (!happyId) return null;
    const prefix = flavor === 'codex' ? 'GPT' : 'Claude';
    const title = await runHtask(root, ['title', '--happy', happyId, '--prefix', prefix]);
    if (title.code !== 0) {
        logger.debug(`[bang:htask] title read skipped: ${title.stderr || title.stdout}`);
        return null;
    }
    return title.stdout.trim() || null;
}

export async function readHtaskCurrent(root: string, happyId: string): Promise<Record<string, unknown> | null> {
    if (!happyId) return null;
    const result = await runHtask(root, ['current', '--happy', happyId, '--format', 'json']);
    if (result.code !== 0) {
        logger.debug(`[bang:htask] current read skipped: ${result.stderr || result.stdout}`);
        return null;
    }
    try {
        const parsed = JSON.parse(result.stdout);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        logger.debug('[bang:htask] current JSON parse failed:', error);
        return null;
    }
}
