import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Verifies that `HAPPY_CODEX_APP_SERVER_BIN` lets integration tests redirect
 * the spawned codex binary to a fake script (mirrors happier's
 * `HAPPIER_CODEX_APP_SERVER_BIN` override).
 */

const { mockSpawn, mockExecSync } = vi.hoisted(() => ({
    mockSpawn: vi.fn(),
    mockExecSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    spawn: mockSpawn,
    execSync: mockExecSync,
}));

vi.mock('child_process', () => ({
    spawn: mockSpawn,
    execSync: mockExecSync,
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import AFTER mocks are registered.
import { createCodexAppServerClient } from '../codexAppServerClient';

type MockChild = EventEmitter & {
    stdin: {
        write: (chunk: string, enc: string, cb: (err?: Error) => void) => boolean;
        end: () => void;
        writableEnded: boolean;
        destroyed: boolean;
    };
    stdout: EventEmitter & { setEncoding: (enc: string) => void };
    stderr: EventEmitter & { setEncoding: (enc: string) => void };
    kill: (signal?: string) => void;
};

function makeChild(opts: {
    acknowledgeInitialize: boolean;
    closeOnKill: (signal: string | undefined) => boolean;
    killSignals?: Array<string | undefined>;
    completeWrites?: boolean;
}): MockChild {
    const child = new EventEmitter() as MockChild;
    const stdoutLike = new EventEmitter() as MockChild['stdout'];
    stdoutLike.setEncoding = () => {};
    const stderrLike = new EventEmitter() as MockChild['stderr'];
    stderrLike.setEncoding = () => {};
    child.stdout = stdoutLike;
    child.stderr = stderrLike;
    child.stdin = {
        write: (chunk: string, _enc: string, cb: (err?: Error) => void) => {
            if (opts.acknowledgeInitialize) {
                const msg = JSON.parse(chunk.trim()) as { id?: number | string; method?: string };
                if (msg.method === 'initialize' && msg.id != null) {
                    setImmediate(() => stdoutLike.emit(
                        'data',
                        `${JSON.stringify({ id: msg.id, result: {} })}\n`,
                    ));
                }
            }
            if (opts.completeWrites !== false) cb();
            return true;
        },
        end: () => { child.stdin.writableEnded = true; },
        writableEnded: false,
        destroyed: false,
    };
    child.kill = (signal?: string) => {
        opts.killSignals?.push(signal);
        if (opts.closeOnKill(signal)) {
            setImmediate(() => child.emit('close', 0, signal ?? null));
        }
    };
    return child;
}

/**
 * Build a mock child process that auto-acks JSONRPC requests so that
 * `createCodexAppServerClient()`'s initialize handshake completes.
 * Notifications (no id) are ignored.
 */
function makeAutoAckChild(): MockChild {
    const child = new EventEmitter() as MockChild;
    const stdoutLike = new EventEmitter() as MockChild['stdout'];
    stdoutLike.setEncoding = () => {};
    const stderrLike = new EventEmitter() as MockChild['stderr'];
    stderrLike.setEncoding = () => {};
    child.stdout = stdoutLike;
    child.stderr = stderrLike;
    child.stdin = {
        write: (chunk: string, _enc: string, cb: (err?: Error) => void) => {
            // Parse the JSONRPC message; if it has an id, emit a fake response.
            try {
                const msg = JSON.parse(chunk.trim()) as {
                    id?: number | string;
                    method?: string;
                };
                if (msg.id !== undefined && msg.id !== null) {
                    setImmediate(() => {
                        stdoutLike.emit(
                            'data',
                            `${JSON.stringify({ id: msg.id, result: {} })}\n`,
                        );
                    });
                }
            } catch {
                // ignore non-JSON writes
            }
            cb();
            return true;
        },
        end: () => {
            child.stdin.writableEnded = true;
            setImmediate(() => child.emit('close', 0, null));
        },
        writableEnded: false,
        destroyed: false,
    };
    child.kill = () => {
        setImmediate(() => child.emit('close', 0, null));
    };
    return child;
}

describe('resolveCodexBinary (HAPPY_CODEX_APP_SERVER_BIN override)', () => {
    const ORIGINAL = process.env.HAPPY_CODEX_APP_SERVER_BIN;

    beforeEach(() => {
        mockSpawn.mockReset();
        mockExecSync.mockReset();
        mockSpawn.mockImplementation(() => makeAutoAckChild());
    });

    afterEach(() => {
        if (ORIGINAL === undefined) {
            delete process.env.HAPPY_CODEX_APP_SERVER_BIN;
        } else {
            process.env.HAPPY_CODEX_APP_SERVER_BIN = ORIGINAL;
        }
    });

    it('uses the override path verbatim when HAPPY_CODEX_APP_SERVER_BIN is set', async () => {
        const overridePath = '/some/fake/path/nonexistent-bin';
        process.env.HAPPY_CODEX_APP_SERVER_BIN = overridePath;

        const client = await createCodexAppServerClient();

        expect(mockExecSync).not.toHaveBeenCalled();
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const [spawnCommand, spawnArgs] = mockSpawn.mock.calls[0]!;
        if (process.platform === 'win32') {
            // Windows wraps via cmd.exe /d /s /c "<bin> <args...>"
            const joinedArgs = (spawnArgs as string[]).join(' ');
            expect(joinedArgs).toContain(overridePath);
        } else {
            expect(spawnCommand).toBe(overridePath);
            expect(spawnArgs).toEqual(['app-server', '--listen', 'stdio://']);
        }

        await client.dispose();
    });

    it('falls back to probing `codex` when HAPPY_CODEX_APP_SERVER_BIN is unset', async () => {
        delete process.env.HAPPY_CODEX_APP_SERVER_BIN;
        mockExecSync.mockReturnValue('codex-cli 0.43.0');

        const client = await createCodexAppServerClient();

        expect(mockExecSync).toHaveBeenCalledTimes(1);
        expect(mockExecSync).toHaveBeenCalledWith('codex --version', expect.any(Object));
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const [spawnCommand, spawnArgs] = mockSpawn.mock.calls[0]!;
        if (process.platform === 'win32') {
            const joinedArgs = (spawnArgs as string[]).join(' ');
            expect(joinedArgs).toContain('codex');
            expect(joinedArgs).not.toContain('/some/fake/path/nonexistent-bin');
        } else {
            expect(spawnCommand).toBe('codex');
        }

        await client.dispose();
    });

    it('ignores an empty-string HAPPY_CODEX_APP_SERVER_BIN and falls back to probing `codex`', async () => {
        process.env.HAPPY_CODEX_APP_SERVER_BIN = '';
        mockExecSync.mockReturnValue('codex-cli 0.43.0');

        const client = await createCodexAppServerClient();

        expect(mockExecSync).toHaveBeenCalledTimes(1);
        const [spawnCommand] = mockSpawn.mock.calls[0]!;
        if (process.platform !== 'win32') {
            expect(spawnCommand).toBe('codex');
        }

        await client.dispose();
    });

    it('bounds initialization and cleans up a non-responsive candidate', async () => {
        process.env.HAPPY_CODEX_APP_SERVER_BIN = '/fake/hanging-codex';
        const killSignals: Array<string | undefined> = [];
        mockSpawn.mockImplementationOnce(() => makeChild({
            acknowledgeInitialize: false,
            closeOnKill: () => true,
            killSignals,
        }));

        await expect(createCodexAppServerClient({
            initializeTimeoutMs: 20,
            disposeTimeoutMs: 20,
            forceKillWaitMs: 20,
        })).rejects.toThrow('initialize timed out after 20ms');
        expect(killSignals).toEqual([undefined]);
    });

    it('bounds initialization when the child never completes its stdin write', async () => {
        process.env.HAPPY_CODEX_APP_SERVER_BIN = '/fake/write-hanging-codex';
        const killSignals: Array<string | undefined> = [];
        mockSpawn.mockImplementationOnce(() => makeChild({
            acknowledgeInitialize: false,
            completeWrites: false,
            closeOnKill: () => true,
            killSignals,
        }));

        await expect(createCodexAppServerClient({
            initializeTimeoutMs: 20,
            disposeTimeoutMs: 20,
            forceKillWaitMs: 20,
        })).rejects.toThrow(/timed out after 20ms/);
        expect(killSignals).toEqual([undefined]);
    });

    it('escalates disposal without waiting forever for an unresponsive child', async () => {
        process.env.HAPPY_CODEX_APP_SERVER_BIN = '/fake/stubborn-codex';
        const killSignals: Array<string | undefined> = [];
        mockSpawn.mockImplementationOnce(() => makeChild({
            acknowledgeInitialize: true,
            closeOnKill: signal => signal === 'SIGKILL',
            killSignals,
        }));
        const client = await createCodexAppServerClient({
            disposeTimeoutMs: 20,
            forceKillWaitMs: 20,
        });

        await client.dispose();

        expect(killSignals).toEqual([undefined, 'SIGKILL']);
    });
});
