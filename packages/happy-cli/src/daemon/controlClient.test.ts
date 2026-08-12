import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readDaemonState } from '@/persistence';
import {
  notifyDaemonCodexProfile,
  shouldSessionEnsureDaemon,
  stopDaemon,
} from './controlClient';

vi.mock('@/persistence', () => ({
  clearDaemonState: vi.fn(),
  readDaemonState: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('daemon launch ownership', () => {
  it('lets only terminal-owned sessions start the daemon', () => {
    expect(shouldSessionEnsureDaemon('daemon')).toBe(false);
    expect(shouldSessionEnsureDaemon('terminal')).toBe(true);
    expect(shouldSessionEnsureDaemon(undefined)).toBe(true);
  });

  it('waits beyond the old two-second window for an accepted graceful stop', { timeout: 8_000 }, async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'stopping' }));
      setTimeout(() => child.kill('SIGTERM'), 2_500).unref();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no TCP port');
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: child.pid!,
      httpPort: address.port,
    } as Awaited<ReturnType<typeof readDaemonState>>);

    try {
      await expect(stopDaemon()).resolves.toBe(true);
    } finally {
      const childExit = child.exitCode === null && child.signalCode === null
        ? once(child, 'exit')
        : Promise.resolve();
      child.kill('SIGKILL');
      const serverClose = server.listening
        ? new Promise<void>(resolve => server.close(() => resolve()))
        : Promise.resolve();
      await Promise.allSettled([childExit, serverClose]);
    }
  });
});

describe('Codex profile restore registration', () => {
  it('retries a bounded 409 window left by an older daemon acknowledgement race', async () => {
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 45678,
    } as Awaited<ReturnType<typeof readDaemonState>>);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyDaemonCodexProfile('session-1', 'default', {
      maxAttempts: 3,
      retryDelayMs: 0,
    });

    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
