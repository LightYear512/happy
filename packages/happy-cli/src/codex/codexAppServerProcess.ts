/** Terminate only a Codex child owned by this runtime, including its CLI shim. */
import { execFile, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { signalOwnedProcess } from '@/utils/processKill';
import { redactSensitive } from './utils/redactSecrets';

export class CodexProcessCleanupError extends Error {
    readonly operationError: unknown;

    constructor(cause: unknown, operationError?: unknown) {
        const previous = cause instanceof CodexProcessCleanupError ? cause : undefined;
        const cleanup = previous ? previous.cause : cause;
        const operation = operationError ?? previous?.operationError;
        const detail = redactSensitive(String(cleanup)).slice(0, 1_024);
        const original = operation === undefined ? ''
            : `; Original operation failed: ${redactSensitive(String(operation)).slice(0, 1_024)}`;
        super(`Codex process cleanup failed: ${detail}${original}`, { cause: cleanup });
        this.name = 'CodexProcessCleanupError';
        this.operationError = operation;
    }
}

/** POSIX callers must spawn the child with detached:true (its own process group). */
export async function stopCodexProcess(
    child: ChildProcess,
    closed: Promise<void>,
    graceMs: number,
    forceWaitMs: number,
): Promise<void> {
    const pid = child.pid;
    if (pid === undefined) {
        // Failed spawn: there is no process to signal; Node still emits close.
        await closed;
        return;
    }
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
        throw new Error('Refusing to terminate an invalid Codex process owner');
    }
    if (process.platform === 'win32') {
        if (child.exitCode === null && child.signalCode === null) {
            await new Promise<void>((resolve, reject) => {
                execFile('taskkill', ['/F', '/T', '/PID', String(pid)], {
                    windowsHide: true, timeout: graceMs + forceWaitMs,
                }, (error) => error ? reject(error) : resolve());
            });
        }
    } else {
        for (const [signal, waitMs] of [['SIGTERM', graceMs], ['SIGKILL', forceWaitMs]] as const) {
            if (!await signalOwnedProcess(-pid, 0)) break;
            await signalOwnedProcess(-pid, signal);
            const deadline = Date.now() + waitMs;
            while (await signalOwnedProcess(-pid, 0) && Date.now() < deadline) {
                await delay(Math.min(20, Math.max(1, deadline - Date.now())));
            }
        }
        if (await signalOwnedProcess(-pid, 0)) throw new Error(`Codex process group ${pid} did not exit`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            closed,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Codex process ${pid} did not close`)), forceWaitMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
