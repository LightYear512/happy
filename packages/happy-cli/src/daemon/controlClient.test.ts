import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuration } from '@/configuration';
import { readDaemonState } from '@/persistence';
import {
  daemonVersionMatchesCurrentProcess,
  notifyDaemonCodexProfile,
  shouldSessionEnsureDaemon,
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

  it('compares daemon state with the executable version instead of mutable package files', () => {
    expect(daemonVersionMatchesCurrentProcess(configuration.currentCliVersion)).toBe(true);
    expect(daemonVersionMatchesCurrentProcess(`${configuration.currentCliVersion}-other`)).toBe(false);
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
