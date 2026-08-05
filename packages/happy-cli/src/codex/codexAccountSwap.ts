export type AccountSwapClient = Readonly<{
    dispose: () => Promise<void>;
}>;

export type AccountSwapResult<T extends AccountSwapClient> =
    | Readonly<{ ok: true; client: T; threadId: string | null }>
    | Readonly<{ ok: false; client: T; error: Error }>;

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
    currentClient: T;
    threadId: string | null;
    createCandidate: () => Promise<T>;
    prepareCandidate?: (client: T) => void;
    resumeCandidate: (client: T, threadId: string) => Promise<string>;
}): Promise<AccountSwapResult<T>> {
    let candidate: T | null = null;
    try {
        candidate = await opts.createCandidate();
        opts.prepareCandidate?.(candidate);
        const resumedThreadId = opts.threadId
            ? await opts.resumeCandidate(candidate, opts.threadId)
            : null;
        await opts.currentClient.dispose();
        return { ok: true, client: candidate, threadId: resumedThreadId };
    } catch (error) {
        if (candidate) {
            await candidate.dispose().catch(() => undefined);
        }
        return {
            ok: false,
            client: opts.currentClient,
            error: error instanceof Error ? error : new Error(String(error)),
        };
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
