/**
 * Codex App-Server JSONRPC Client
 *
 * Spawns `codex app-server --listen stdio://` and communicates via
 * newline-delimited JSONRPC over stdin/stdout.
 */

import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { logger } from '@/ui/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JsonRpcMessage = Readonly<{
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: Readonly<{ code?: number; message?: string }>;
}>;

type JsonRpcRequestHandler = (
    params: unknown,
    message: JsonRpcMessage,
) => Promise<unknown> | unknown;

type JsonRpcNotificationHandler = (params: unknown) => Promise<void> | void;

export type CodexAppServerClient = Readonly<{
    request: (method: string, params?: unknown) => Promise<unknown>;
    notify: (method: string, params?: unknown) => Promise<void>;
    registerRequestHandler: (
        method: string,
        handler: JsonRpcRequestHandler,
    ) => () => void;
    registerNotificationHandler: (
        method: string,
        handler: JsonRpcNotificationHandler,
    ) => () => void;
    dispose: () => Promise<void>;
}>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 14 days – matches the existing MCP client timeout. */
const DEFAULT_REQUEST_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;

const MAX_STDERR_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MessageQueueState = {
    buffer: string;
    fatalError: Error | null;
};

type PendingRequest = Readonly<{
    method: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}>;

function failWaiters(state: MessageQueueState, error: Error): void {
    if (state.fatalError === null) {
        state.fatalError = error;
    }
}

function createJsonRpcError(
    message: string,
    code = -32000,
): Readonly<{ code: number; message: string }> {
    return { code, message };
}

function toMessageKey(
    id: number | string | null | undefined,
): string | null {
    if (id === null || id === undefined) return null;
    return `${typeof id}:${String(id)}`;
}

function createDisposedError(): Error {
    return new Error('Codex app-server client has been disposed');
}

// ---------------------------------------------------------------------------
// Windows cmd.exe argument escaping (ported from happier / cross-spawn)
// ---------------------------------------------------------------------------

const cmdMetaCharsRegExp = /([()\][\-%!^"`<>&|;, *?])/g;

function escapeCmdArgument(arg: string): string {
    // Based on https://qntm.org/cmd (same algorithm as cross-spawn)
    let s = `${arg}`;
    s = s.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
    s = s.replace(/(?=(\\+?)?)\1$/, '$1$1');
    s = `"${s}"`;
    s = s.replace(cmdMetaCharsRegExp, '^$1');
    return s;
}

/**
 * Wrap a command + args list for safe spawn on Windows. On non-Windows
 * platforms returns the input unchanged. On Windows, wraps with
 * `cmd.exe /d /s /c "..."` and escapes arguments per the cross-spawn
 * algorithm so that `.cmd`/`.bat` shims (e.g. the npm-installed `codex`)
 * receive arguments verbatim, preserving embedded quotes such as
 * `-c web_search="disabled"`.
 *
 * Caller must pass the returned `windowsVerbatimArguments` flag to
 * `child_process.spawn` options.
 */
export function buildWindowsSpawnArgs(
    command: string,
    args: string[],
): { spawnCommand: string; spawnArgs: string[]; windowsVerbatimArguments: boolean } {
    if (process.platform !== 'win32') {
        return { spawnCommand: command, spawnArgs: args, windowsVerbatimArguments: false };
    }
    const comspec = process.env.COMSPEC || 'cmd.exe';
    const escapedParts = [command, ...args.map(a => escapeCmdArgument(a))].join(' ');
    return {
        spawnCommand: comspec,
        spawnArgs: ['/d', '/s', '/c', `"${escapedParts}"`],
        windowsVerbatimArguments: true,
    };
}

function sanitizeEnv(
    processEnv: NodeJS.ProcessEnv,
): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of Object.keys(processEnv)) {
        if (key === 'CODEX_THREAD_ID') continue;
        const value = processEnv[key];
        if (typeof value === 'string') {
            env[key] = value;
        }
    }
    return env;
}

/**
 * Resolve the codex binary command. On Windows we may need to go through
 * `cmd /c` or similar — but the simplest portable approach is to just invoke
 * `codex` and let the shell resolve it (same as codexMcpClient).
 */
function resolveCodexBinary(): string {
    try {
        execSync('codex --version', { encoding: 'utf8', windowsHide: true });
        return 'codex';
    } catch {
        throw new Error(
            'Codex CLI not found or not executable.\n' +
                '\n' +
                'To install codex:\n' +
                '  npm install -g @openai/codex\n' +
                '\n' +
                'Alternatively, use Claude:\n' +
                '  happy claude',
        );
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createCodexAppServerClient(opts?: {
    processEnv?: Record<string, string>;
    cwd?: string;
    /** TOML config overrides passed as `--config-override key=value` CLI args (e.g. MCP server injection). */
    configOverrides?: readonly string[];
}): Promise<CodexAppServerClient> {
    const command = resolveCodexBinary();
    const args = ['app-server', '--listen', 'stdio://'];
    // Append config overrides as CLI args (codex uses `-c key=value`, same as happier)
    if (opts?.configOverrides) {
        for (const override of opts.configOverrides) {
            args.push('-c', override);
        }
    }
    const env = sanitizeEnv(opts?.processEnv ?? process.env);
    const cwd = opts?.cwd ?? process.cwd();

    // On Windows, npm-installed CLIs are `.cmd` shims that need cmd.exe wrapping
    // with proper argument escaping (same approach as happier's resolveWindowsCommandInvocation).
    const { spawnCommand, spawnArgs, windowsVerbatimArguments } = buildWindowsSpawnArgs(command, args);

    logger.debug(
        `[CodexAppServer] Spawning: ${spawnCommand} ${spawnArgs.join(' ')} (cwd=${cwd})`,
    );

    const child = spawn(spawnCommand, spawnArgs, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments,
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
        throw new Error(
            'Failed to start Codex app-server with piped stdio',
        );
    }

    // -----------------------------------------------------------------------
    // Internal state
    // -----------------------------------------------------------------------

    const state: MessageQueueState = { buffer: '', fatalError: null };
    let stderrBuffer = '';

    const pendingRequests = new Map<string, PendingRequest>();
    const requestHandlers = new Map<string, JsonRpcRequestHandler>();
    const notificationHandlers = new Map<
        string,
        Set<JsonRpcNotificationHandler>
    >();

    let writeChain = Promise.resolve();
    let nextId = 0;
    let disposing = false;
    let disposePromise: Promise<void> | null = null;
    let resolveClosed: (() => void) | null = null;

    const closedPromise = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    const failPendingRequests = (error: Error): void => {
        for (const [requestKey, pending] of Array.from(
            pendingRequests.entries(),
        )) {
            pendingRequests.delete(requestKey);
            pending.reject(error);
        }
    };

    const failWith = (error: unknown): void => {
        const failure =
            error instanceof Error ? error : new Error(String(error));
        failWaiters(state, failure);
        failPendingRequests(failure);
    };

    const sendMessage = async (
        message: Record<string, unknown>,
    ): Promise<void> => {
        if (state.fatalError) {
            throw state.fatalError;
        }

        let payload: string;
        try {
            payload = `${JSON.stringify(message)}\n`;
        } catch (error) {
            const reason =
                error instanceof Error ? error.message : String(error);
            const method =
                typeof message.method === 'string'
                    ? message.method
                    : 'notification';
            throw new Error(
                `Failed to serialize Codex app-server ${method} message: ${reason}`,
            );
        }

        const nextWrite = writeChain.then(async () => {
            const stdin = child.stdin;
            if (!stdin || stdin.writableEnded || stdin.destroyed) {
                throw state.fatalError ?? createDisposedError();
            }
            await new Promise<void>((resolve, reject) => {
                try {
                    stdin.write(payload, 'utf8', (error) => {
                        if (error) {
                            reject(error);
                            return;
                        }
                        resolve();
                    });
                } catch (err) {
                    reject(err);
                }
            });
        });
        writeChain = nextWrite.catch(() => undefined);
        await nextWrite;
    };

    const handleServerRequest = async (
        message: JsonRpcMessage,
    ): Promise<void> => {
        if (typeof message.method !== 'string') return;
        const requestKey = toMessageKey(message.id);
        if (!requestKey) return;

        const handler = requestHandlers.get(message.method);
        if (!handler) {
            await sendMessage({
                id: message.id,
                error: createJsonRpcError(
                    `No handler registered for ${message.method}`,
                    -32601,
                ),
            });
            return;
        }
        try {
            const result = await handler(message.params, message);
            await sendMessage({ id: message.id, result: result ?? null });
        } catch (error) {
            const failure =
                error instanceof Error ? error : new Error(String(error));
            await sendMessage({
                id: message.id,
                error: createJsonRpcError(failure.message),
            });
        }
    };

    const handleIncomingMessage = (message: JsonRpcMessage): void => {
        const requestKey = toMessageKey(message.id);

        // Server request: has method + id
        if (typeof message.method === 'string') {
            if (requestKey) {
                void handleServerRequest(message).catch((error) => {
                    failWith(error);
                });
                return;
            }
            // Notification: has method, no id
            const handlers = notificationHandlers.get(message.method);
            if (handlers && handlers.size > 0) {
                for (const handler of Array.from(handlers)) {
                    try {
                        const result = handler(message.params);
                        if (
                            result &&
                            typeof (result as PromiseLike<void>).then ===
                                'function'
                        ) {
                            void Promise.resolve(result).catch(
                                (error: unknown) => {
                                    failWith(error);
                                },
                            );
                        }
                    } catch (error) {
                        failWith(error);
                    }
                }
            }
            return;
        }

        // Response: no method, has id
        if (!requestKey) return;
        const pending = pendingRequests.get(requestKey);
        if (!pending) return;
        pendingRequests.delete(requestKey);

        if (message.error) {
            pending.reject(
                new Error(
                    message.error.message ??
                        `Codex app-server request failed: ${pending.method}`,
                ),
            );
            return;
        }
        pending.resolve(message.result);
    };

    // -----------------------------------------------------------------------
    // Wire up child process I/O
    // -----------------------------------------------------------------------

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        state.buffer += chunk;
        while (true) {
            const newlineIndex = state.buffer.indexOf('\n');
            if (newlineIndex === -1) break;
            const rawLine = state.buffer.slice(0, newlineIndex).trim();
            state.buffer = state.buffer.slice(newlineIndex + 1);
            if (!rawLine) continue;
            try {
                handleIncomingMessage(
                    JSON.parse(rawLine) as JsonRpcMessage,
                );
            } catch (error) {
                failWith(
                    new Error(
                        `Invalid Codex app-server JSON output: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                );
                return;
            }
        }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        logger.debug(`[CodexAppServer] stderr: ${chunk.trim()}`);
        if (stderrBuffer.length >= MAX_STDERR_CHARS) return;
        stderrBuffer = (stderrBuffer + chunk).slice(0, MAX_STDERR_CHARS);
    });

    child.once('error', (error) => {
        failWith(
            new Error(
                `Failed to launch Codex app-server: ${error.message}`,
            ),
        );
    });

    child.once('close', (code, signal) => {
        logger.debug(`[CodexAppServer] Child process closed: code=${code ?? 'null'} signal=${signal ?? 'null'} disposing=${disposing}`);
        resolveClosed?.();
        if (disposing) return;
        const suffix = stderrBuffer.trim()
            ? `\n${stderrBuffer.trim()}`
            : '';
        failWith(
            new Error(
                `Codex app-server exited before completing the request (code=${code ?? 'null'} signal=${signal ?? 'null'})${suffix}`,
            ),
        );
    });

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    const request = async (
        method: string,
        requestParams?: unknown,
    ): Promise<unknown> => {
        const id = ++nextId;
        const requestKey = toMessageKey(id);
        if (!requestKey) {
            throw new Error(
                `Failed to create Codex app-server request id for ${method}`,
            );
        }

        const responsePromise = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingRequests.delete(requestKey);
                reject(
                    new Error(
                        `Codex app-server request ${method} timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`,
                    ),
                );
            }, DEFAULT_REQUEST_TIMEOUT_MS);

            pendingRequests.set(requestKey, {
                method,
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
        });

        try {
            await sendMessage({
                id,
                method,
                // Codex app-server rejects requests that omit the `params` field entirely.
                params: requestParams === undefined ? {} : requestParams,
            });
        } catch (error) {
            const failure =
                error instanceof Error ? error : new Error(String(error));
            const pending = pendingRequests.get(requestKey);
            pendingRequests.delete(requestKey);
            pending?.reject(failure);
        }

        return await responsePromise;
    };

    const notify = async (
        method: string,
        notificationParams?: unknown,
    ): Promise<void> => {
        await sendMessage({
            method,
            // Codex app-server rejects notifications that omit the `params` field entirely.
            params:
                notificationParams === undefined ? {} : notificationParams,
        });
    };

    const registerRequestHandler = (
        method: string,
        handler: JsonRpcRequestHandler,
    ): (() => void) => {
        requestHandlers.set(method, handler);
        return () => {
            if (requestHandlers.get(method) === handler) {
                requestHandlers.delete(method);
            }
        };
    };

    const registerNotificationHandler = (
        method: string,
        handler: JsonRpcNotificationHandler,
    ): (() => void) => {
        const existing = notificationHandlers.get(method);
        if (existing) {
            existing.add(handler);
        } else {
            notificationHandlers.set(method, new Set([handler]));
        }
        return () => {
            const handlers = notificationHandlers.get(method);
            if (!handlers) return;
            handlers.delete(handler);
            if (handlers.size === 0) {
                notificationHandlers.delete(method);
            }
        };
    };

    const dispose = async (): Promise<void> => {
        if (disposePromise) return await disposePromise;
        disposing = true;

        const disposedError = createDisposedError();
        failWaiters(state, disposedError);
        failPendingRequests(disposedError);

        disposePromise = (async () => {
            try {
                child.stdin?.end();
            } catch {
                // ignore
            }
            try {
                child.kill();
            } catch {
                // ignore
            }
            await closedPromise;
        })();

        return await disposePromise;
    };

    // -----------------------------------------------------------------------
    // Initialization handshake
    // -----------------------------------------------------------------------

    try {
        logger.debug('[CodexAppServer] Sending initialize request');
        await request('initialize', {
            clientInfo: {
                name: 'happy-codex-client',
                version: '1.0.0',
            },
            capabilities: {
                experimentalApi: true,
            },
        });
        await notify('initialized');
        logger.debug('[CodexAppServer] Initialization complete');

        return {
            request,
            notify,
            registerRequestHandler,
            registerNotificationHandler,
            dispose,
        };
    } catch (error) {
        await dispose().catch(() => undefined);
        throw error;
    }
}
