import { CodexAppServerRequestTimeout } from './codexAppServerClient';
import { CodexProcessCleanupError } from './codexAppServerProcess';

export type AccountSwapClient = Readonly<{
    dispose: () => Promise<void>;
}>;

export type AccountSwapResult<T extends AccountSwapClient> =
    | Readonly<{ ok: true; client: T; threadId: string | null }>
    | Readonly<{ ok: false; client: T | null; error: Error; cleanupFailed: boolean }>;

export class CodexAccountSwapCancelled extends Error {
    constructor() {
        super('Codex account recovery superseded or cancelled');
        this.name = 'CodexAccountSwapCancelled';
    }
}

export function requireExactCodexThreadResume(
    resumedThreadId: string | null,
    expectedThreadId: string,
): string {
    if (!resumedThreadId) {
        throw new Error('thread/resume returned no thread id');
    }
    if (resumedThreadId !== expectedThreadId) {
        throw new Error(
            `thread/resume identity mismatch: expected ${expectedThreadId}, got ${resumedThreadId}`,
        );
    }
    return resumedThreadId;
}

export async function performCodexAccountSwap<T extends AccountSwapClient>(opts: {
    currentClient: T | null;
    threadId: string | null;
    createCandidate: () => Promise<T>;
    prepareCandidate?: (client: T) => void;
    resumeCandidate: (client: T, threadId: string) => Promise<string>;
    /** Called synchronously before disposal invalidates the current client. */
    onCurrentRetired?: () => void;
    isCurrent?: () => boolean;
    /** At most one cold retry, only for a resume RPC timeout after clean exit. */
    recoverResumeTimeout?: boolean;
    /** An explicit same-profile restart cannot resume beside its own writer. */
    retireBeforeResume?: boolean;
}): Promise<AccountSwapResult<T>> {
    let current = opts.currentClient;
    const requireCurrent = (): void => {
        if (opts.isCurrent?.() === false) throw new CodexAccountSwapCancelled();
    };
    const retireCurrent = async (): Promise<void> => {
        const retiring = current;
        if (!retiring) return;
        current = null;
        opts.onCurrentRetired?.();
        try { await retiring.dispose(); }
        catch (error) { throw new CodexProcessCleanupError(error); }
    };
    if (opts.retireBeforeResume) {
        try { requireCurrent(); await retireCurrent(); }
        catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            return { ok: false, client: current, error: failure,
                cleanupFailed: failure instanceof CodexProcessCleanupError };
        }
    }
    for (let attempt = 0; ; attempt += 1) {
        let candidate: T | null = null;
        try {
            requireCurrent();
            candidate = await opts.createCandidate();
            requireCurrent();
            opts.prepareCandidate?.(candidate);
            const resumedThreadId = opts.threadId
                ? await opts.resumeCandidate(candidate, opts.threadId)
                : null;
            requireCurrent();
            await retireCurrent();
            requireCurrent();
            return { ok: true, client: candidate, threadId: resumedThreadId };
        } catch (error) {
            let failure = error instanceof Error ? error : new Error(String(error));
            if (candidate) {
                try { await candidate.dispose(); }
                catch (cleanup) { failure = new CodexProcessCleanupError(cleanup, failure); }
            }
            if (attempt === 0 && opts.recoverResumeTimeout
                && failure instanceof CodexAppServerRequestTimeout && failure.method === 'thread/resume'
                && opts.isCurrent?.() !== false) {
                try {
                    await retireCurrent();
                    requireCurrent();
                    continue;
                } catch (cleanup) {
                    failure = cleanup instanceof CodexProcessCleanupError
                        ? new CodexProcessCleanupError(cleanup, failure)
                        : cleanup instanceof Error ? cleanup : new Error(String(cleanup));
                }
            }
            return {
                ok: false, client: current, error: failure,
                cleanupFailed: failure instanceof CodexProcessCleanupError,
            };
        }
    }
}

export type McpAccountRestartResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: Error; rollbackError: Error | null }>;

export async function performCodexMcpAccountRestart(
    client: Readonly<{ reconnect: () => Promise<void> }>,
    targetHome: string | undefined,
): Promise<McpAccountRestartResult> {
    const previousHome = process.env.CODEX_HOME;
    if (targetHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = targetHome;
    try {
        await client.reconnect();
        return { ok: true };
    } catch (error) {
        if (previousHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousHome;
        let rollbackError: Error | null = null;
        try {
            await client.reconnect();
        } catch (rollback) {
            rollbackError = rollback instanceof Error ? rollback : new Error(String(rollback));
        }
        return {
            ok: false,
            error: error instanceof Error ? error : new Error(String(error)),
            rollbackError,
        };
    }
}
