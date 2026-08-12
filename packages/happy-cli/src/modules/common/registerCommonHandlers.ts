import { logger } from '@/ui/logger';
import { exec, type ExecOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { RpcHandlerManager } from '../../api/rpc/RpcHandlerManager';
import { validatePath } from './pathSecurity';
import type { PermissionMode } from '@/api/types';

const execAsync = promisify(exec);
const BASH_MAX_BUFFER_BYTES = 1_048_576;
const DISABLED_REPOSITORY_RPC_METHODS = [
    'readFile', 'writeFile', 'listDirectory', 'getDirectoryTree', 'ripgrep', 'difftastic',
] as const;
const repositoryRpcDisabled = async (): Promise<{ success: false; error: string }> => ({
    success: false,
    error: 'Repository file access is disabled in this Happy client',
});
const gitStatusSyncDisableFile = join(homedir(), '.happy', 'disable-git-status-sync');
const automaticGitStatusCommands = new Set([
    'git rev-parse --is-inside-work-tree',
    'git status --porcelain=v2 --branch --show-stash --untracked-files=all',
    'git status --porcelain=v2 --branch --untracked-files=all',
    'git diff --numstat',
    'git diff --cached --numstat',
]);

function isAutomaticGitStatusSyncDisabled(command: string): boolean {
    return automaticGitStatusCommands.has(command)
        && (process.env.HAPPY_DISABLE_GIT_STATUS_SYNC === '1' || existsSync(gitStatusSyncDisableFile));
}

interface BashRequest {
    command: string;
    cwd?: string;
    timeout?: number;
}

interface BashResponse {
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
}

export interface SpawnSessionOptions {
    machineId?: string;
    directory: string;
    sessionId?: string;
    resume?: string;
    title?: string;
    titleAuthority?: 'external';
    restoreSessionId?: string;
    consoleSession?: boolean;
    approvedNewDirectoryCreation?: boolean;
    agent?: 'claude' | 'codex' | 'gemini';
    permissionMode?: PermissionMode;
    token?: string;
    environmentVariables?: {
        CODEX_HOME?: string;
        ANTHROPIC_BASE_URL?: string;
        ANTHROPIC_AUTH_TOKEN?: string;
        ANTHROPIC_MODEL?: string;
        TMUX_SESSION_NAME?: string;
        TMUX_TMPDIR?: string;
    };
    xcReplacement?: { sessionId: string; previousOpener: string; providerBinding: string };
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string }
    | { type: 'superseded' };

export function registerCommonHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    for (const method of DISABLED_REPOSITORY_RPC_METHODS) {
        rpcHandlerManager.registerHandler(method, repositoryRpcDisabled);
    }
    rpcHandlerManager.registerHandler<BashRequest, BashResponse>('bash', async (data) => {
        logger.debug('Shell command request:', data.command);
        if (isAutomaticGitStatusSyncDisabled(data.command)) {
            return { success: false, exitCode: 1,
                error: `Automatic git status sync disabled by ${gitStatusSyncDisableFile}` };
        }
        if (data.cwd && data.cwd !== '/') {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) return { success: false, error: validation.error };
        }
        const options: ExecOptions = {
            cwd: data.cwd === '/' ? undefined : data.cwd,
            timeout: data.timeout || 30_000,
            maxBuffer: BASH_MAX_BUFFER_BYTES,
            windowsHide: true,
        };
        try {
            const { stdout, stderr } = await execAsync(data.command, options);
            return { success: true, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '', exitCode: 0 };
        } catch (error) {
            const execError = error as NodeJS.ErrnoException & {
                stdout?: string;
                stderr?: string;
                code?: number | string;
                killed?: boolean;
            };
            if (execError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
                return { success: false, exitCode: -1, error: 'Command output exceeded 1 MiB limit' };
            }
            if (execError.code === 'ETIMEDOUT' || execError.killed) {
                return { success: false, stdout: execError.stdout ?? '', stderr: execError.stderr ?? '',
                    exitCode: typeof execError.code === 'number' ? execError.code : -1, error: 'Command timed out' };
            }
            return { success: false, stdout: execError.stdout?.toString() ?? '',
                stderr: execError.stderr?.toString() ?? execError.message ?? 'Command failed',
                exitCode: typeof execError.code === 'number' ? execError.code : 1,
                error: execError.message ?? 'Command failed' };
        }
    });
}
