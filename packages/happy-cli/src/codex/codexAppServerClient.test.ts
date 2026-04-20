import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Readable } from 'node:stream';

const {
    mockExecSync,
    mockSpawn,
} = vi.hoisted(() => ({
    mockExecSync: vi.fn().mockReturnValue('codex 0.115.0'),
    mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    execSync: mockExecSync,
    spawn: mockSpawn,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('../package.json', () => ({
    default: { version: '0.0.1-test' },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockRpcMessage = {
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
};

/** Push a JSON-RPC line to the mock process stdout. */
function pushLine(
    stdout: import('stream').Readable & { push(chunk: string): void },
    payload: unknown,
) {
    stdout.push(JSON.stringify(payload) + '\n');
}

/**
 * Create a mock child process with controllable stdin/stdout/stderr.
 *
 * - Automatically responds to `initialize` so that `createCodexAppServerClient()`
 *   can complete its handshake without any extra test setup.
 * - `kill()` emits `'close'` so that `dispose()` resolves correctly.
 * - Pass `onRequest` to handle additional server-initiated or user-triggered
 *   requests per test.
 */
function createMockProcess(opts?: {
    pid?: number;
    onRequest?: (msg: MockRpcMessage, reply: (response: MockRpcMessage) => void) => void;
}) {
    const { Readable, Writable } = require('stream') as typeof import('stream');
    const events = require('events') as typeof import('events');

    const stdin = new Writable({ write(_chunk: unknown, _enc: unknown, cb: () => void) { cb(); } });
    const stdout = new Readable({ read() {} }) as Readable & { push(chunk: string): void };
    const stderr = new Readable({ read() {} });
    const proc = Object.assign(new events.EventEmitter(), {
        pid: opts?.pid ?? 12345,
        stdin,
        stdout,
        stderr,
        kill: vi.fn(),
    });

    // When kill() is called, emit 'close' so that dispose() resolves.
    (proc.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
        setImmediate(() => proc.emit('close', 0, null));
    });

    const originalWrite = stdin.write.bind(stdin);
    stdin.write = (chunk: unknown, ...rest: unknown[]) => {
        const text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const msg: MockRpcMessage = JSON.parse(trimmed);
                if (msg.id !== undefined && msg.method) {
                    if (msg.method === 'initialize') {
                        // Always auto-respond to initialize so the handshake completes.
                        setImmediate(() =>
                            pushLine(stdout, { id: msg.id, result: { capabilities: {} } }),
                        );
                    } else if (opts?.onRequest) {
                        opts.onRequest(msg, (resp) =>
                            pushLine(stdout, { id: msg.id, ...resp }),
                        );
                    }
                }
            } catch { /* skip */ }
        }
        return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    };

    return { proc, stdout, stderr, stdin };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCodexAppServerClient', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('spawns the codex app-server process', async () => {
        const { proc } = createMockProcess();
        mockSpawn.mockReturnValue(proc);

        const { createCodexAppServerClient } = await import('./codexAppServerClient');
        const client = await createCodexAppServerClient();

        expect(mockSpawn).toHaveBeenCalledOnce();
        // On Windows, codex is wrapped via cmd.exe; check the combined command string.
        const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
        const combined = [cmd, ...args].join(' ');
        // On Windows cmd.exe wraps args; check that codex and stdio:// are present.
        expect(combined).toContain('codex');
        expect(combined).toContain('stdio://');

        await client.dispose();
    });

    it('passes configOverrides as -c args', async () => {
        const { proc } = createMockProcess();
        mockSpawn.mockReturnValue(proc);

        const { createCodexAppServerClient } = await import('./codexAppServerClient');
        const client = await createCodexAppServerClient({
            configOverrides: ['model.provider=openai', 'sandbox=false'],
        });

        expect(mockSpawn).toHaveBeenCalledOnce();
        // On Windows the args are cmd.exe-escaped into a single string; check combined.
        const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
        const combined = args.join(' ');
        expect(combined).toContain('model.provider=openai');
        expect(combined).toContain('sandbox=false');

        await client.dispose();
    });

    it('sends a JSON-RPC request and resolves with the response', async () => {
        const { proc } = createMockProcess({
            onRequest: (msg, reply) => {
                if (msg.method === 'test/method') {
                    reply({ result: { value: 42 } });
                }
            },
        });
        mockSpawn.mockReturnValue(proc);

        const { createCodexAppServerClient } = await import('./codexAppServerClient');
        const client = await createCodexAppServerClient();

        const result = await client.request('test/method', { foo: 'bar' });
        expect(result).toEqual({ value: 42 });

        await client.dispose();
    });

    it('rejects request on JSON-RPC error response', async () => {
        const { proc } = createMockProcess({
            onRequest: (msg, reply) => {
                if (msg.method === 'test/fail') {
                    reply({ error: { code: -32600, message: 'Invalid request' } });
                }
            },
        });
        mockSpawn.mockReturnValue(proc);

        const { createCodexAppServerClient } = await import('./codexAppServerClient');
        const client = await createCodexAppServerClient();

        await expect(client.request('test/fail', {})).rejects.toThrow('Invalid request');

        await client.dispose();
    });

    it('calls registered notification handlers on incoming notifications', async () => {
        const { proc, stdout } = createMockProcess();
        mockSpawn.mockReturnValue(proc);

        const { createCodexAppServerClient } = await import('./codexAppServerClient');
        const client = await createCodexAppServerClient();

        const handler = vi.fn();
        client.registerNotificationHandler('agent/event', handler);

        await new Promise(r => setTimeout(r, 10));
        pushLine(stdout, { method: 'agent/event', params: { type: 'message', text: 'hello' } });

        await new Promise(r => setTimeout(r, 20));
        expect(handler).toHaveBeenCalledWith({ type: 'message', text: 'hello' });

        await client.dispose();
    });

    it('unregisters notification handler when returned cleanup is called', async () => {
        const { proc, stdout } = createMockProcess();
        mockSpawn.mockReturnValue(proc);

        const { createCodexAppServerClient } = await import('./codexAppServerClient');
        const client = await createCodexAppServerClient();

        const handler = vi.fn();
        const unregister = client.registerNotificationHandler('agent/event', handler);
        unregister();

        await new Promise(r => setTimeout(r, 10));
        pushLine(stdout, { method: 'agent/event', params: { text: 'ignored' } });

        await new Promise(r => setTimeout(r, 20));
        expect(handler).not.toHaveBeenCalled();

        await client.dispose();
    });

    it('responds to server-initiated requests via registerRequestHandler', async () => {
        const { proc, stdout, stdin } = createMockProcess();
        mockSpawn.mockReturnValue(proc);

        // Collect all writes (including initialize/initialized) to inspect responses.
        const writes: MockRpcMessage[] = [];
        const origWrite = stdin.write.bind(stdin);
        stdin.write = (chunk: unknown, ...rest: unknown[]) => {
            const text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
            for (const line of text.split('\n')) {
                const t = line.trim();
                if (t) try { writes.push(JSON.parse(t)); } catch { /* skip */ }
            }
            return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
        };

        const { createCodexAppServerClient } = await import('./codexAppServerClient');
        const client = await createCodexAppServerClient();

        client.registerRequestHandler('permissions/review', async (_params) => {
            return { decision: 'approved' };
        });

        await new Promise(r => setTimeout(r, 10));
        pushLine(stdout, { id: 99, method: 'permissions/review', params: { tool: 'write_file' } });

        await new Promise(r => setTimeout(r, 30));

        const response = writes.find(m => m.id === 99);
        expect(response).toBeDefined();
        expect(response?.result).toEqual({ decision: 'approved' });

        await client.dispose();
    });

    it('sends error response when no handler registered for server request', async () => {
        const { proc, stdout, stdin } = createMockProcess();
        mockSpawn.mockReturnValue(proc);

        const writes: MockRpcMessage[] = [];
        const origWrite = stdin.write.bind(stdin);
        stdin.write = (chunk: unknown, ...rest: unknown[]) => {
            const text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
            for (const line of text.split('\n')) {
                const t = line.trim();
                if (t) try { writes.push(JSON.parse(t)); } catch { /* skip */ }
            }
            return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
        };

        const { createCodexAppServerClient } = await import('./codexAppServerClient');
        const client = await createCodexAppServerClient();

        await new Promise(r => setTimeout(r, 10));
        pushLine(stdout, { id: 7, method: 'unknown/method', params: {} });

        await new Promise(r => setTimeout(r, 30));

        const response = writes.find(m => m.id === 7);
        expect(response?.error).toBeDefined();
        expect(response?.error?.code).toBe(-32601);

        await client.dispose();
    });

    it('sends a JSON-RPC notification (no id, no response expected)', async () => {
        const { proc, stdin } = createMockProcess();
        mockSpawn.mockReturnValue(proc);

        const writes: MockRpcMessage[] = [];
        const origWrite = stdin.write.bind(stdin);
        stdin.write = (chunk: unknown, ...rest: unknown[]) => {
            const text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
            for (const line of text.split('\n')) {
                const t = line.trim();
                if (t) try { writes.push(JSON.parse(t)); } catch { /* skip */ }
            }
            return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
        };

        const { createCodexAppServerClient } = await import('./codexAppServerClient');
        const client = await createCodexAppServerClient();

        await client.notify('agent/cancel', { reason: 'user_abort' });

        await new Promise(r => setTimeout(r, 20));

        const notification = writes.find(m => m.method === 'agent/cancel' && m.id === undefined);
        expect(notification).toBeDefined();
        expect(notification?.params).toEqual({ reason: 'user_abort' });

        await client.dispose();
    });

    it('rejects pending requests when process exits unexpectedly', async () => {
        const { proc } = createMockProcess({
            onRequest: (_msg, _reply) => {
                // Do not respond — simulates a slow/hung request.
            },
        });
        mockSpawn.mockReturnValue(proc);

        const { createCodexAppServerClient } = await import('./codexAppServerClient');
        const client = await createCodexAppServerClient();

        const requestPromise = client.request('slow/method', {});

        await new Promise(r => setTimeout(r, 10));
        // Simulate process crash — implementation listens for 'close'.
        proc.emit('close', 1, null);

        await expect(requestPromise).rejects.toThrow();
    });

    it('dispose resolves cleanly and marks client as disposed', async () => {
        const { proc } = createMockProcess();
        mockSpawn.mockReturnValue(proc);

        const { createCodexAppServerClient } = await import('./codexAppServerClient');
        const client = await createCodexAppServerClient();

        await expect(client.dispose()).resolves.toBeUndefined();

        // After dispose, requests should reject.
        await expect(client.request('any/method', {})).rejects.toThrow();
    });

    it('handles multi-line stdout correctly (partial lines)', async () => {
        const { proc, stdout } = createMockProcess();
        mockSpawn.mockReturnValue(proc);

        const { createCodexAppServerClient } = await import('./codexAppServerClient');
        const client = await createCodexAppServerClient();

        const handler = vi.fn();
        client.registerNotificationHandler('ping', handler);

        await new Promise(r => setTimeout(r, 10));
        // Send in two chunks (simulates partial TCP-style delivery).
        const full = JSON.stringify({ method: 'ping', params: { seq: 1 } }) + '\n';
        stdout.push(full.slice(0, 10));
        await new Promise(r => setTimeout(r, 5));
        stdout.push(full.slice(10));

        await new Promise(r => setTimeout(r, 30));
        expect(handler).toHaveBeenCalledWith({ seq: 1 });

        await client.dispose();
    });
});
