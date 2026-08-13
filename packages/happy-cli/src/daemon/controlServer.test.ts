import { describe, expect, it } from 'vitest';
import { startDaemonControlServer } from './controlServer';

describe('startDaemonControlServer', () => {
  const permitShutdown = async () => ({ accepted: true as const });

  it('rejects unsafe kill-sessions before scheduling daemon shutdown', async () => {
    const shutdowns: unknown[] = [];
    const server = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: async () => true,
      restoreSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      prepareShutdown: async () => ({ accepted: false, error: 'unmanaged user session' }),
      requestShutdown: () => { shutdowns.push(true); },
      onHappySessionWebhook: () => undefined,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stopSessions: true }),
      });
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({ status: 'blocked', error: 'unmanaged user session' });
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(shutdowns).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it('schedules shutdown only after preflight accepts', async () => {
    let shutdowns = 0;
    const server = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: async () => true,
      restoreSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      prepareShutdown: permitShutdown,
      requestShutdown: () => { shutdowns += 1; },
      onHappySessionWebhook: () => undefined,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/stop`, { method: 'POST' });
      expect(await response.json()).toEqual({ status: 'stopping' });
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(shutdowns).toBe(1);
    } finally {
      await server.stop();
    }
  });

  it('does not expose the daemon console session in list responses', async () => {
    const server = await startDaemonControlServer({
      getChildren: () => [
        {
          startedBy: 'daemon',
          happySessionId: 'console-session',
          pid: 1001,
          inputState: 'online',
          isConsoleSession: true,
        },
        {
          startedBy: 'daemon',
          happySessionId: 'user-session',
          pid: 1002,
          inputState: 'online',
        },
        {
          startedBy: 'daemon',
          happySessionId: 'restoring-session',
          pid: 1003,
          inputState: 'unknown',
        },
        {
          startedBy: 'daemon',
          happySessionId: 'ready-restored-session',
          pid: 1004,
          inputState: 'online',
        },
        {
          startedBy: 'daemon',
          happySessionId: 'terminal-session',
          inputState: 'offline',
          pid: 1005,
        },
      ],
      stopSession: async () => true,
      restoreSession: async () => ({ type: 'success', sessionId: 'unused', agent: 'codex' }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      prepareShutdown: permitShutdown,
      requestShutdown: () => undefined,
      onHappySessionWebhook: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/list`, {
        method: 'POST',
      });

      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({
        children: [
          {
            startedBy: 'daemon',
            happySessionId: 'user-session',
            pid: 1002,
            turnState: 'unknown',
            turnToken: null,
          },
          {
            startedBy: 'daemon',
            happySessionId: 'restoring-session',
            pid: 1003,
            turnState: 'unknown',
            turnToken: null,
          },
          {
            startedBy: 'daemon',
            happySessionId: 'ready-restored-session',
            pid: 1004,
            turnState: 'unknown',
            turnToken: null,
          },
        ],
        presenceVersion: 2,
        unknownSessionIds: ['restoring-session'],
      });
    } finally {
      await server.stop();
    }
  });

  it('validates and forwards process-owned turn updates', async () => {
    const updates: unknown[] = [];
    const server = await startDaemonControlServer({
      getChildren: () => [], stopSession: async () => true,
      restoreSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      prepareShutdown: permitShutdown, requestShutdown: () => undefined,
      onHappySessionWebhook: () => undefined,
      onSessionTurn: async (sessionId, pid, turn) => {
        updates.push({ sessionId, pid, turn }); return true;
      },
    });
    try {
      const turn = { sourceId: '00000000-0000-4000-8000-000000000001', sequence: 1,
        state: 'running', token: `xc-turn-v1-${'a'.repeat(64)}` } as const;
      const response = await fetch(`http://127.0.0.1:${server.port}/session-turn`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-a', pid: 42, turn }),
      });
      expect(response.ok).toBe(true);
      expect(updates).toEqual([{ sessionId: 'session-a', pid: 42, turn }]);
    } finally { await server.stop(); }
  });

  it('forwards exact provider readiness through the local session webhook', async () => {
    const webhooks: unknown[] = [];
    const server = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: async () => true,
      restoreSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      prepareShutdown: permitShutdown,
      requestShutdown: () => undefined,
      onHappySessionWebhook: (sessionId, metadata, readyProviderSessionId) => {
        webhooks.push({ sessionId, metadata, readyProviderSessionId });
      },
    });

    try {
      const body = {
        sessionId: 'happy-session',
        metadata: { flavor: 'codex', hostPid: 42 },
        readyProviderSessionId: '00000000-0000-4000-8000-000000000001',
        transportHealth: { schema: 'invalid-proof-is-validated-by-the-daemon-owner' },
      };
      const response = await fetch(`http://127.0.0.1:${server.port}/session-started`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.ok).toBe(true);
      expect(webhooks).toEqual([{
        sessionId: body.sessionId,
        metadata: body.metadata,
        readyProviderSessionId: body.readyProviderSessionId,
      }]);

      const hostile = await fetch(`http://127.0.0.1:${server.port}/session-started`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, readyProviderSessionId: 'not-a-provider-id' }),
      });
      expect(hostile.status).toBe(400);
      expect(webhooks).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it('accepts only a validated Codex profile update owned by the exact Happy session', async () => {
    const updates: unknown[] = [];
    const server = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: async () => true,
      restoreSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      prepareShutdown: permitShutdown,
      requestShutdown: () => undefined,
      onHappySessionWebhook: () => undefined,
      onCodexProfile: async (sessionId, profileName) => {
        updates.push({ sessionId, profileName });
        return sessionId === 'happy-session';
      },
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/session-codex-profile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'happy-session', profileName: 'eliasi' }),
      });
      expect(response.ok).toBe(true);
      expect(updates).toEqual([{ sessionId: 'happy-session', profileName: 'eliasi' }]);

      const hostile = await fetch(`http://127.0.0.1:${server.port}/session-codex-profile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'happy-session', profileName: '../eliasi' }),
      });
      expect(hostile.status).toBe(400);
      expect(updates).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it('restores by one Happy session ID without invoking the spawn boundary', async () => {
    const restored: Array<{ sessionId: string; permissionMode?: string }> = [];
    let spawnEffects = 0;
    const server = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: async () => true,
      restoreSession: async (sessionId, permissionMode) => {
        restored.push({ sessionId, permissionMode });
        return { type: 'success', sessionId, agent: 'codex' };
      },
      spawnSession: async () => { spawnEffects += 1; return { type: 'success', sessionId: 'new-session' }; },
      prepareShutdown: permitShutdown,
      requestShutdown: () => undefined,
      onHappySessionWebhook: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/restore-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'requested-session', permissionMode: 'bypassPermissions' }),
      });

      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({ success: true, sessionId: 'requested-session', agent: 'codex' });
      expect(restored).toEqual([
        { sessionId: 'requested-session', permissionMode: 'bypassPermissions' },
      ]);
      expect(spawnEffects).toBe(0);

      const hostile = await fetch(`http://127.0.0.1:${server.port}/restore-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'requested-session', resume: 'forged-provider-thread' }),
      });
      expect(hostile.status).toBe(400);
      expect(restored).toEqual([
        { sessionId: 'requested-session', permissionMode: 'bypassPermissions' },
      ]);
    } finally {
      await server.stop();
    }
  });

  it('forwards one validated permission mode through the spawn boundary', async () => {
    const spawned: unknown[] = [];
    const server = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: async () => true,
      restoreSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      spawnSession: async (options) => {
        spawned.push(options);
        return { type: 'success', sessionId: 'created-session' };
      },
      prepareShutdown: permitShutdown,
      requestShutdown: () => undefined,
      onHappySessionWebhook: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/spawn-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directory: '/tmp/workspace',
          agent: 'codex',
          permissionMode: 'bypassPermissions',
        }),
      });

      expect(response.ok).toBe(true);
      expect(spawned).toEqual([{
        directory: '/tmp/workspace',
        agent: 'codex',
        permissionMode: 'bypassPermissions',
      }]);

      const hostile = await fetch(`http://127.0.0.1:${server.port}/spawn-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: '/tmp/workspace', permissionMode: 'root' }),
      });
      expect(hostile.status).toBe(400);
      expect(spawned).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it('replaces one explicitly closed session with its complete XC provenance tuple', async () => {
    const replacements: unknown[] = [];
    const server = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: async () => true,
      restoreSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      replaceSession: async (input) => {
        replacements.push(input);
        return { type: 'success', sessionId: 'new-happy-session', agent: 'codex' };
      },
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      prepareShutdown: permitShutdown,
      requestShutdown: () => undefined,
      onHappySessionWebhook: () => undefined,
    });
    try {
      const body = { previousSessionId: 'old-happy-session',
        providerSessionId: '019f8425-0e76-7b83-bed0-019efc0b6f8f',
        virtualSessionId: 'x-000042', title: 'Work' };
      const response = await fetch(`http://127.0.0.1:${server.port}/replace-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({ success: true, sessionId: 'new-happy-session', agent: 'codex' });
      expect(replacements).toEqual([body]);

      const group = { ...body, virtualSessionId: 'x-000015-1' };
      const groupResponse = await fetch(`http://127.0.0.1:${server.port}/replace-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(group),
      });
      expect(groupResponse.ok).toBe(true);
      expect(replacements).toEqual([body, group]);

      const hostile = await fetch(`http://127.0.0.1:${server.port}/replace-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, virtualSessionId: 'x-000015-0' }),
      });
      expect(hostile.status).toBe(400);
      expect(replacements).toEqual([body, group]);
    } finally {
      await server.stop();
    }
  });
});
