import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const watchEnsures = new Map<string, Promise<void>>();
const PROJECT_SESSION_STOP_TIMEOUT_MS = 2_000;
const PROJECT_SESSION_LIFECYCLE_TIMEOUT_MS = 25_000;

function detail(error: unknown, timeoutMs = PROJECT_SESSION_LIFECYCLE_TIMEOUT_MS): string {
    if (error && typeof error === 'object' && 'killed' in error && error.killed === true) {
        return `XC v2 command timed out after ${String(timeoutMs)}ms`;
    }
    const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr.trim() : '';
    try {
        const value: unknown = JSON.parse(stderr);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const row = value as Record<string, unknown>;
            const fields = Object.fromEntries(['code', 'message', 'reason', 'path']
                .filter((key) => typeof row[key] === 'string').map((key) => [key, row[key]]));
            if (Object.keys(fields).length) return JSON.stringify(fields);
        }
    } catch {}
    return (stderr || (error instanceof Error ? error.message : String(error))).replace(/\s+/gu, ' ').trim().slice(0, 500);
}

async function startupEntry(workspace: string): Promise<string | null> {
    try {
        const entry = join(await realpath(workspace), 'xcoding-v2', 'xc');
        const info = await lstat(entry);
        return info.isFile() && !info.isSymbolicLink() && await realpath(entry) === entry ? entry : null;
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
    }
}

async function invokeProjectXc(workspace: string, args: readonly string[], options: {
    env?: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
}) {
    const entry = await startupEntry(workspace);
    if (!entry) return null;
    return execFileAsync('node', [entry, ...args], {
        cwd: workspace,
        env: options.env ?? process.env,
        encoding: 'utf8',
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
    });
}

interface ProjectSessionOptions {
    workspace: string;
    nativeSessionId?: string;
    notify: (message: string) => void;
    env?: NodeJS.ProcessEnv;
}

interface ProjectSessionCommandResult {
    context: string | null;
}

export function installHappySessionEnvironment(
    nativeSessionId: string,
    env: NodeJS.ProcessEnv = process.env,
): void {
    const sessionId = nativeSessionId.trim();
    if (!sessionId) throw new Error('Happy session ID is unavailable');
    env.HAPPY_CHAT_ID = sessionId;
    env.XC_HOST = 'happy';
    env.XC_CONVERSATION_ID = sessionId;
    env.XC_HOST_NAME = 'Happy';
}

export interface ProjectErrorReportOptions {
    workspace: string;
    source: string;
    code: string;
    message: string;
    reportedBy?: string;
}

async function runProjectSessionCommand(
    action: 'startup' | 'close', options: ProjectSessionOptions,
): Promise<ProjectSessionCommandResult | null | undefined> {
    const sessionId = options.nativeSessionId;
    if (!sessionId) return null;
    const workspace = resolve(options.workspace);
    try {
        const env = { ...(options.env ?? process.env) };
        installHappySessionEnvironment(sessionId, env);
        const result = await invokeProjectXc(workspace, ['host', action, '--workspace', workspace], {
            env,
            timeout: PROJECT_SESSION_LIFECYCLE_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
        });
        if (!result) return null;
        const output = result.stdout.trim();
        if (!output) return null;
        const value = JSON.parse(output) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('XC v2 startup returned an invalid visible message');
        }
        const row = value as { systemMessage?: unknown;
            hookSpecificOutput?: { additionalContext?: unknown } };
        const message = typeof row.systemMessage === 'string' && row.systemMessage.trim() ? row.systemMessage : null;
        if (action === 'startup' && !message) throw new Error('XC v2 startup returned an invalid visible message');
        if (message) options.notify(message);
        const context = row.hookSpecificOutput?.additionalContext;
        if (context !== undefined && (typeof context !== 'string' || !context.trim())) {
            throw new Error('XC v2 input returned invalid model context');
        }
        return {
            context: typeof context === 'string' ? context : null,
        };
    } catch (error) {
        const failure = detail(error, PROJECT_SESSION_LIFECYCLE_TIMEOUT_MS);
        options.notify(`${action === 'startup' ? '旧版本迁移错误' : action === 'close' ? 'XC v2 关闭错误' : 'XC v2 输入错误'}：${failure}`);
        return undefined;
    }
}

export async function runProjectSessionStartup(options: ProjectSessionOptions): Promise<boolean> {
    return await runProjectSessionCommand('startup', options) !== undefined;
}

export async function runProjectSessionStop(options: ProjectSessionOptions): Promise<boolean | null> {
    const sessionId = options.nativeSessionId;
    if (!sessionId) return null;
    const workspace = resolve(options.workspace);
    try {
        const env = { ...(options.env ?? process.env) };
        installHappySessionEnvironment(sessionId, env);
        const result = await invokeProjectXc(workspace,
            ['host', 'stop', '--confirm', '--workspace', workspace], {
                env,
                timeout: PROJECT_SESSION_STOP_TIMEOUT_MS,
                maxBuffer: 1024 * 1024,
            });
        if (!result) return null;
        const value: unknown = JSON.parse(result.stdout);
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || (value as { requested?: unknown }).requested !== true) {
            throw new Error('XC v2 safe stop returned an invalid result');
        }
        return true;
    } catch (error) {
        options.notify(`XC v2 安全停止错误：${detail(error, PROJECT_SESSION_STOP_TIMEOUT_MS)}`);
        return false;
    }
}

export async function runProjectSessionClose(options: ProjectSessionOptions): Promise<void> {
    await runProjectSessionCommand('close', options);
}

export async function reportProjectError(options: ProjectErrorReportOptions): Promise<string | null> {
    const workspace = resolve(options.workspace);
    try {
        const result = await invokeProjectXc(workspace, ['bug', 'report',
            '--source', options.source,
            '--code', options.code,
            '--message', options.message,
            ...(options.reportedBy ? ['--reported-by', options.reportedBy] : []),
            '--workspace', workspace,
        ], {
            timeout: 10_000,
            maxBuffer: 1024 * 1024,
        });
        if (!result) return null;
        const value = JSON.parse(result.stdout) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const notice = (value as { buglistRecord?: { notice?: unknown } }).buglistRecord?.notice;
        return typeof notice === 'string' && notice.trim() ? notice : null;
    } catch {
        return null;
    }
}

export function ensureProjectWatch(options: {
    workspace: string;
    env?: NodeJS.ProcessEnv;
}): Promise<void> {
    const workspace = resolve(options.workspace);
    const current = watchEnsures.get(workspace);
    if (current) return current;
    const operation = (async () => {
        await invokeProjectXc(workspace, ['watch', 'ensure', '--workspace', workspace], {
            env: options.env ?? process.env,
            timeout: 5_000,
            maxBuffer: 1024 * 1024,
        });
    })();
    const shared = operation.finally(() => {
        if (watchEnsures.get(workspace) === shared) watchEnsures.delete(workspace);
    });
    watchEnsures.set(workspace, shared);
    return shared;
}
