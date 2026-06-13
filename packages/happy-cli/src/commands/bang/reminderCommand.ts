import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '@/ui/logger';
import type { BangCommandContext, BangCommandResult } from './types';

function findHtaskRoot(): string | null {
    let dir = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    for (;;) {
        if (existsSync(join(dir, '.agents', 'htask', 'htask.py'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function runHtask(root: string, args: string[], input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
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

function currentHappyId(ctx: BangCommandContext): string {
    const clientSessionId = (ctx.client as unknown as { sessionId?: string }).sessionId;
    return (clientSessionId || process.env.HTASK_SESSION_CONFIG_ID || process.env.HAPPY_SESSION_ID || '').trim();
}

function reminderBlock(text: string): string | null {
    const matches = [...text.matchAll(/<htask>([\s\S]*?)<\/htask>/g)];
    for (const match of matches) {
        const block = (match[1] || '').trim();
        if (/@reminder (?:已|未修改)/.test(block)) return block;
    }
    return null;
}

async function syncHtaskTitle(root: string, happyId: string, ctx: BangCommandContext): Promise<void> {
    if (!happyId) return;
    const prefix = ctx.flavor === 'codex' ? 'GPT' : 'Claude';
    const title = await runHtask(root, ['title', '--happy', happyId, '--prefix', prefix]);
    if (title.code !== 0) {
        logger.debug(`[bang:reminder] title sync skipped: ${title.stderr || title.stdout}`);
        return;
    }
    const summary = title.stdout.trim();
    if (!summary) return;
    try {
        ctx.client.sendClaudeSessionMessage({
            type: 'summary',
            summary,
            leafUuid: randomUUID(),
        } as never);
    } catch (error) {
        logger.debug('[bang:reminder] title sync failed:', error);
    }
}

export async function handleReminderBangCommand(_args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const root = findHtaskRoot();
    if (!root) {
        return {
            message: '⚠️ 当前目录未发现 .agents/htask/htask.py，无法切换任务提醒。',
            action: 'none',
        };
    }

    const happyId = currentHappyId(ctx);
    const payload = JSON.stringify({ session_id: happyId, prompt: '@reminder' });
    const result = await runHtask(root, ['inject', '--stdin-hook'], payload);
    if (result.code !== 0) {
        return {
            message: `⚠️ @reminder 执行失败: ${(result.stderr || result.stdout || `exit ${result.code}`).trim()}`,
            action: 'none',
        };
    }

    const message = reminderBlock(result.stdout) || '⚠️ @reminder 未返回任务提醒结果。';
    if (message.includes('@reminder 已')) {
        await syncHtaskTitle(root, happyId, ctx);
    }
    return { message, action: 'none' };
}
