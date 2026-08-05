import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '@/ui/logger';
import type { BangCommandContext } from './types';

const HTASK_SAFE_REF = /^[A-Za-z0-9_.-]+$/;

export function findHtaskRoot(): string | null {
    let dir = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    for (;;) {
        if (existsSync(join(dir, '.agents', 'htask', 'htask.py'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

export function runHtask(
    root: string,
    args: string[],
    input = '',
    env?: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolveRun, reject) => {
        const child = spawn('python3', [join(root, '.agents', 'htask', 'htask.py'), ...args], {
            cwd: root,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: env ? { ...process.env, ...env } : process.env,
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

export function buildHtaskClaudeEnvironment(
    nativeSessionId: string,
    base: Record<string, string> = {},
): Record<string, string> {
    const sessionId = nativeSessionId.trim();
    return sessionId
        ? { ...base, HTASK_SESSION_CONFIG_ID: sessionId }
        : { ...base };
}

function isSafeHtaskRef(value: unknown): value is string {
    return typeof value === 'string' && HTASK_SAFE_REF.test(value);
}

function readJsonObject(path: string, debugLabel: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch (error) {
        logger.debug(`[bang:htask] ${debugLabel} read skipped:`, error);
        return null;
    }
}

function readHtaskDirectBinding(root: string, happyId: string, expectedTaskId = ''): { happyId: string; taskId: string } | null {
    if (!isSafeHtaskRef(happyId)) return null;
    const cfg = readJsonObject(join(root, '.htask', 'cfg', `${happyId}.json`), `cfg ${happyId}`);
    const taskId = cfg?.task_id;
    if (!isSafeHtaskRef(taskId) || (expectedTaskId && taskId !== expectedTaskId)) return null;
    const cfgLease = cfg?.writer_lease;
    const lease = readJsonObject(join(root, '.htask', 'lease', 'task', `${taskId}.json`), `lease ${taskId}`);
    if (!cfgLease || typeof cfgLease !== 'object' || Array.isArray(cfgLease) || !lease) return null;
    const cfgLeaseRec = cfgLease as { token?: unknown; epoch?: unknown };
    if (lease.happy_id !== happyId || lease.task_id !== taskId) return null;
    if (!cfgLeaseRec.token || lease.token !== cfgLeaseRec.token) return null;
    if (Number(lease.epoch || 0) !== Number(cfgLeaseRec.epoch || 0)) return null;
    return { happyId, taskId };
}

function readStableHappyFromSessionConfig(root: string, sessionId: string): { happyId: string; taskId: string } | null {
    if (!isSafeHtaskRef(sessionId)) return null;
    const config = readJsonObject(join(root, '.happy', 'session-config', `${sessionId}.json`), `session-config ${sessionId}`);
    const skills = config?.skills;
    const htask = skills && typeof skills === 'object' && !Array.isArray(skills)
        ? (skills as { htask?: unknown }).htask
        : null;
    if (!htask || typeof htask !== 'object' || Array.isArray(htask)) return null;
    const rec = htask as { bound?: unknown; stable_happy?: unknown; happy_id?: unknown; task_id?: unknown };
    if (rec.bound !== true) return null;
    const happyId = isSafeHtaskRef(rec.stable_happy) ? rec.stable_happy : rec.happy_id;
    const taskId = rec.task_id;
    if (!isSafeHtaskRef(happyId) || !isSafeHtaskRef(taskId)) return null;
    if (!readHtaskDirectBinding(root, happyId, taskId)) return null;

    return { happyId, taskId };
}

function hasBoundHtaskSessionConfig(root: string, sessionId: string): boolean {
    if (!isSafeHtaskRef(sessionId)) return false;
    const config = readJsonObject(join(root, '.happy', 'session-config', `${sessionId}.json`), `session-config ${sessionId}`);
    const skills = config?.skills;
    const htask = skills && typeof skills === 'object' && !Array.isArray(skills)
        ? (skills as { htask?: unknown }).htask
        : null;
    return !!htask && typeof htask === 'object' && !Array.isArray(htask)
        && (htask as { bound?: unknown }).bound === true;
}

export function resolveHtaskHappyId(root: string, sessionId: string): string {
    const projected = readStableHappyFromSessionConfig(root, sessionId);
    if (projected) return projected.happyId;
    if (hasBoundHtaskSessionConfig(root, sessionId)) return '';
    return readHtaskDirectBinding(root, sessionId)?.happyId ?? '';
}

export function buildHtaskPromptPayload(sessionId: string, happyId: string, prompt: string): string {
    const payload: Record<string, string> = {
        session_id: happyId || sessionId,
        prompt,
    };
    if (sessionId && (!happyId || happyId !== sessionId)) {
        payload.native_session_id = sessionId;
    }
    return JSON.stringify(payload);
}

export async function restoreHtaskSessionConfig(root: string, sessionId: string, reason: string): Promise<boolean> {
    if (!isSafeHtaskRef(sessionId)) return false;
    const result = await runHtask(root, ['session-config-restore', '--reason', reason], '', {
        HTASK_SESSION_CONFIG_ID: sessionId,
        HAPPY_SESSION_ID: sessionId,
        HAPPY_CHAT_ID: sessionId,
    });
    if (result.code !== 0) {
        logger.debug(`[bang:htask] session-config restore skipped: ${result.stderr || result.stdout}`);
        return false;
    }
    logger.debug(`[bang:htask] session-config restored: ${result.stdout.trim()}`);
    return true;
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
