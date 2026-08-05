import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { deterministicStringify } from '@/utils/deterministicJson';
import type { SessionTransportHealthRecord } from '@/api/sessionTransportHealth';
import type { TrackedSession } from './types';
import {
  buildDaemonSessionArgs,
  buildDaemonChildEnvironment,
  buildRestoreProfileEnvironment,
  canResumeCurrentDaemonChild,
  classifyTrackedInputState,
  createSessionStartupDeadline,
  DEFAULT_DAEMON_SESSION_AGENT,
  filterProfileEnvironmentVariablesForAgent,
  isDaemonManagedSession,
  isProviderReadyForDaemonRegistration,
  isCurrentDaemonChild,
  isTrackedProviderRestoreReady,
  matchesExpectedHappySessionId,
  reconcileLiveTrackedSessionOwnership,
  recoverRestoredDaemonSessions,
  resumeCurrentDaemonChildProcess,
  parseRestoreFileData,
  runSerial,
  sessionErrorLocalId,
  SESSION_IDENTITY_TIMEOUT_MS,
  SESSION_PROVIDER_READY_TIMEOUT_MS,
  trackedSessionMatchesIdentity,
  transportProofAdvanced,
  updateTrackedProviderReadiness,
  updateTrackedTransportHealth,
  waitForTrackedSessionStartup,
} from './run';

describe('session startup deadline', () => {
  it('hands the initial identity deadline to the slower provider readiness proof exactly once', async () => {
    vi.useFakeTimers();
    try {
      const phases: string[] = [];
      const deadline = createSessionStartupDeadline((phase) => phases.push(phase));
      await vi.advanceTimersByTimeAsync(SESSION_IDENTITY_TIMEOUT_MS - 1);
      deadline.providerIdentified();
      deadline.providerIdentified();
      await vi.advanceTimersByTimeAsync(SESSION_PROVIDER_READY_TIMEOUT_MS - 1);
      expect(phases).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(phases).toEqual(['provider']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the bounded missing-identity failure and cancels completed starts', async () => {
    vi.useFakeTimers();
    try {
      const phases: string[] = [];
      createSessionStartupDeadline((phase) => phases.push(phase));
      await vi.advanceTimersByTimeAsync(SESSION_IDENTITY_TIMEOUT_MS);
      expect(phases).toEqual(['identity']);
      const completed = createSessionStartupDeadline((phase) => phases.push(phase));
      completed.providerIdentified();
      completed.cancel();
      await vi.advanceTimersByTimeAsync(SESSION_PROVIDER_READY_TIMEOUT_MS);
      expect(phases).toEqual(['identity']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates the exact child before reporting a startup timeout', async () => {
    vi.useFakeTimers();
    try {
      let awaiter: Parameters<Parameters<typeof waitForTrackedSessionStartup>[0]['register']>[0]
        | undefined;
      let registered = true;
      const terminate = vi.fn(async () => true);
      const result = waitForTrackedSessionStartup({
        pid: 42,
        register: value => { awaiter = value; },
        unregister: () => { registered = false; },
        terminate,
        complete: session => ({ type: 'success', sessionId: session.happySessionId! }),
      });

      expect(awaiter).toBeDefined();
      await vi.advanceTimersByTimeAsync(SESSION_IDENTITY_TIMEOUT_MS);
      await expect(result).resolves.toEqual({
        type: 'error',
        errorMessage: 'Session webhook timeout for PID 42',
      });
      expect(registered).toBe(false);
      expect(terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports cleanup failure instead of leaving a timeout looking terminally clean', async () => {
    vi.useFakeTimers();
    try {
      const result = waitForTrackedSessionStartup({
        pid: 43,
        suffix: ' (tmux)',
        register: () => {},
        unregister: () => {},
        terminate: async () => false,
        complete: session => ({ type: 'success', sessionId: session.happySessionId! }),
      });
      await vi.advanceTimersByTimeAsync(SESSION_IDENTITY_TIMEOUT_MS);
      await expect(result).resolves.toEqual({
        type: 'error',
        errorMessage: 'Session webhook timeout for PID 43 (tmux); process cleanup failed',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up the exact child when final startup projection throws', async () => {
    let awaiter: Parameters<Parameters<typeof waitForTrackedSessionStartup>[0]['register']>[0]
      | undefined;
    const terminate = vi.fn(async () => true);
    const result = waitForTrackedSessionStartup({
      pid: 44,
      register: value => { awaiter = value; },
      unregister: () => {},
      terminate,
      complete: () => { throw new Error('projection failed'); },
    });

    awaiter!.resolve({ startedBy: 'daemon', pid: 44, happySessionId: 'session-a' });
    await expect(result).resolves.toEqual({ type: 'error', errorMessage: 'projection failed' });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('rejects a late success after timeout cleanup has started', async () => {
    vi.useFakeTimers();
    try {
      let awaiter: Parameters<Parameters<typeof waitForTrackedSessionStartup>[0]['register']>[0]
        | undefined;
      let finishCleanup: ((value: boolean) => void) | undefined;
      const result = waitForTrackedSessionStartup({
        pid: 45,
        register: value => { awaiter = value; },
        unregister: () => {},
        terminate: () => new Promise(resolve => { finishCleanup = resolve; }),
        complete: session => ({ type: 'success', sessionId: session.happySessionId! }),
      });

      await vi.advanceTimersByTimeAsync(SESSION_IDENTITY_TIMEOUT_MS);
      awaiter!.resolve({ startedBy: 'daemon', pid: 45, happySessionId: 'late-session' });
      finishCleanup!(true);
      await expect(result).resolves.toEqual({
        type: 'error',
        errorMessage: 'Session webhook timeout for PID 45',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function transportHealth(overrides: Record<string, unknown> = {}): SessionTransportHealthRecord {
  const updatedAt = String(overrides.updatedAt ?? '2026-08-01T00:00:20.000Z');
  const state = String(overrides.state ?? 'connected');
  const base = {
    schema: 'xc.happy-session-transport-health.v1', nativeSessionId: 'session-a', processId: 42,
    processStartedAt: '2026-08-01T00:00:00.000Z', generation: 2, state, reconnectCount: 0,
    queueMessages: 0, queueBytes: 0, reason: null,
    connectedAt: '2026-08-01T00:00:10.000Z',
    disconnectedAt: ['ownership_conflict', 'failed', 'closed'].includes(state) ? updatedAt : null,
    updatedAt,
    ...overrides,
  };
  return { ...base, recordDigest: `sha256:${createHash('sha256')
    .update(deterministicStringify(base)).digest('hex')}` } as SessionTransportHealthRecord;
}

describe('buildDaemonSessionArgs', () => {
  it('projects one permission property through new and restored Codex starts', () => {
    expect(buildDaemonSessionArgs({
      directory: '/workspace',
      restoreSessionId: 'happy-session',
      resume: 'codex-thread',
      permissionMode: 'bypassPermissions',
    }, 'codex')).toEqual([
      'codex',
      '--happy-starting-mode', 'remote',
      '--started-by', 'daemon',
      '--resume', 'codex-thread',
      '--happy-restore-session', 'happy-session',
      '--permission-mode', 'bypassPermissions',
    ]);
  });
});

describe('recoverRestoredDaemonSessions', () => {
  it('recovers every trusted process so duplicate identities can be retired explicitly', () => {
    const command = 'node dist/index.mjs codex --started-by daemon --happy-restore-session session-a';
    expect(recoverRestoredDaemonSessions([
      { pid: 41, command, type: 'daemon-spawned-session' },
      { pid: 42, command: 'node dist/index.mjs --started-by daemon --happy-restore-session /bad',
        type: 'daemon-spawned-session' },
      { pid: 43, command, type: 'user-session' },
      { pid: 44, command: `${command} --happy-restore-session session-b`, type: 'daemon-spawned-session' },
    ])).toEqual([{ pid: 41, sessionId: 'session-a' }]);
    expect(recoverRestoredDaemonSessions([
      { pid: 41, command, type: 'daemon-spawned-session' },
      { pid: 44, command, type: 'daemon-spawned-session' },
    ])).toEqual([
      { pid: 41, sessionId: 'session-a' },
      { pid: 44, sessionId: 'session-a' },
    ]);
  });
});

describe('buildDaemonChildEnvironment', () => {
  it('removes daemon Codex identity from a new session so the configured default is authoritative', () => {
    expect(buildDaemonChildEnvironment({
      CODEX_HOME: '/accounts/xie1',
      CODEX_THREAD_ID: 'old-thread',
      HAPPY_RESUME_TITLE: 'old-title',
      HAPPY_TITLE_AUTHORITY: 'external',
      PATH: '/bin',
    }, {}, 'codex')).toEqual({ PATH: '/bin' });
  });

  it('preserves explicit account and title inputs while removing the inherited thread', () => {
    expect(buildDaemonChildEnvironment({
      CODEX_HOME: '/accounts/xie1',
      CODEX_THREAD_ID: 'old-thread',
      HAPPY_RESUME_TITLE: 'old-title',
    }, {
      CODEX_HOME: '/accounts/gelle',
      HAPPY_RESUME_TITLE: 'New session',
      HAPPY_TITLE_AUTHORITY: 'external',
    }, 'codex', 'resume-thread')).toEqual({
      CODEX_HOME: '/accounts/gelle',
      HAPPY_RESUME_TITLE: 'New session',
      HAPPY_TITLE_AUTHORITY: 'external',
    });
  });

  it('removes daemon Codex identity from a resumed session so the current default is authoritative', () => {
    expect(buildDaemonChildEnvironment({
      CODEX_HOME: '/accounts/xie1',
      CODEX_THREAD_ID: 'old-thread',
    }, {}, 'codex', 'resume-thread')).toEqual({});
  });
});

describe('DEFAULT_DAEMON_SESSION_AGENT', () => {
  it('preserves Claude as the default daemon-spawned agent when no explicit agent is provided', () => {
    expect(DEFAULT_DAEMON_SESSION_AGENT).toBe('claude');
  });
});

describe('filterProfileEnvironmentVariablesForAgent', () => {
  it('removes Codex model env keys so CODEX_HOME/config.toml remains authoritative', () => {
    expect(filterProfileEnvironmentVariablesForAgent({
      OPENAI_API_KEY: 'key',
      OPENAI_BASE_URL: 'https://example.test',
      OPENAI_MODEL: 'gpt-5.6',
      OPENAI_SMALL_FAST_MODEL: 'gpt-5.6-mini',
      CODEX_MODEL: 'gpt-5.6',
      CODEX_SMALL_FAST_MODEL: 'gpt-5.6-mini',
    }, 'codex')).toEqual({
      OPENAI_API_KEY: 'key',
      OPENAI_BASE_URL: 'https://example.test',
    });
  });

  it('leaves non-Codex profile env untouched', () => {
    const env = {
      OPENAI_MODEL: 'gpt-5.6',
      ANTHROPIC_MODEL: 'claude-sonnet',
    };

    expect(filterProfileEnvironmentVariablesForAgent(env, 'claude')).toBe(env);
  });
});

describe('matchesExpectedHappySessionId', () => {
  it('accepts new-session webhooks and exact restore identities only', () => {
    expect(matchesExpectedHappySessionId(undefined, 'new-session')).toBe(true);
    expect(matchesExpectedHappySessionId('session-a', 'session-a')).toBe(true);
    expect(matchesExpectedHappySessionId('session-a', 'replacement-session')).toBe(false);
  });
});

describe('isProviderReadyForDaemonRegistration', () => {
  it('daemon registration requires a durable provider id for fresh Codex children', () => {
    const codex = { flavor: 'codex', startedBy: 'daemon' } as const;
    expect(isProviderReadyForDaemonRegistration(codex)).toBe(false);
    expect(isProviderReadyForDaemonRegistration({
      ...codex,
      claudeSessionId: '00000000-0000-4000-8000-000000000001',
    })).toBe(true);
    expect(isProviderReadyForDaemonRegistration({
      flavor: 'claude',
      startedBy: 'daemon',
    })).toBe(true);
    expect(isProviderReadyForDaemonRegistration({
      flavor: 'codex',
      startedBy: 'terminal',
    })).toBe(true);
  });
});

describe('isTrackedProviderRestoreReady', () => {
  it('requires an exact Codex resume proof only for restored Codex children', () => {
    const restored = { expectedHappySessionId: 'happy-session', resumeTarget:
      '00000000-0000-4000-8000-000000000001' };
    expect(isTrackedProviderRestoreReady(restored, { flavor: 'codex' }, undefined)).toBe(false);
    expect(isTrackedProviderRestoreReady(restored, { flavor: 'codex' },
      '00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isTrackedProviderRestoreReady(restored, { flavor: 'codex' },
      '00000000-0000-4000-8000-000000000002')).toBe(false);
    expect(isTrackedProviderRestoreReady(restored, { flavor: 'claude' }, undefined)).toBe(true);
    expect(isTrackedProviderRestoreReady({ resumeTarget: restored.resumeTarget },
      { flavor: 'codex' }, undefined)).toBe(true);
  });

  it('latches an exact restore proof across later ordinary webhooks', () => {
    const session: TrackedSession = { startedBy: 'daemon', pid: 42,
      expectedHappySessionId: 'happy-session', resumeTarget:
      '00000000-0000-4000-8000-000000000001' };
    expect(updateTrackedProviderReadiness(session, { flavor: 'codex' }, session.resumeTarget))
      .toEqual({ explicitMismatch: false, ready: true });
    expect(session.observedProviderSessionId).toBe(session.resumeTarget);

    expect(updateTrackedProviderReadiness(session, { flavor: 'codex' }, undefined))
      .toEqual({ explicitMismatch: false, ready: true });
    expect(updateTrackedProviderReadiness(session, { flavor: 'codex' },
      '00000000-0000-4000-8000-000000000002'))
      .toEqual({ explicitMismatch: true, ready: false });
    expect(session.observedProviderSessionId).toBe(session.resumeTarget);
  });
});

describe('tracked input transport presence', () => {
  it('derives ordinary readiness while old-daemon recovery stays unknown without current proof', () => {
    const ordinary: TrackedSession = { startedBy: 'daemon', pid: 42, happySessionId: 'session-a' };
    expect(classifyTrackedInputState(ordinary)).toBe('online');
    expect(classifyTrackedInputState({ ...ordinary, expectedHappySessionId: 'session-a' })).toBe('unknown');
  });

  it('accepts only a fresh exact current-process proof and separates terminal from unknown', () => {
    const now = Date.parse('2026-08-01T00:00:25.000Z');
    const session: TrackedSession = { startedBy: 'daemon', pid: 42, happySessionId: 'session-a' };
    expect(updateTrackedTransportHealth(session, 'session-a', 42, transportHealth(), now)).toBe(true);
    expect(classifyTrackedInputState(session, now)).toBe('online');

    session.transportHealth = transportHealth({ state: 'closed', generation: 3 });
    expect(classifyTrackedInputState(session, now)).toBe('offline');
    session.transportHealth = transportHealth({ updatedAt: '2026-08-01T00:00:40.000Z', generation: 4 });
    expect(classifyTrackedInputState(session, now)).toBe('unknown');
    session.transportHealth = transportHealth({ updatedAt: '2026-07-31T23:59:00.000Z', generation: 4 });
    expect(classifyTrackedInputState(session, now)).toBe('unknown');
    session.transportHealth = transportHealth({ nativeSessionId: 'session-b', generation: 4 });
    expect(classifyTrackedInputState(session, now)).toBe('unknown');
  });

  it('rejects regressed, changed-process and future evidence without erasing the last proof', () => {
    const now = Date.parse('2026-08-01T00:00:25.000Z');
    const session: TrackedSession = { startedBy: 'daemon', pid: 42, happySessionId: 'session-a' };
    expect(updateTrackedTransportHealth(session, 'session-a', 42, transportHealth(), now)).toBe(true);
    expect(updateTrackedTransportHealth(session, 'session-a', 42,
      transportHealth({ generation: 1 }), now)).toBe(false);
    expect(classifyTrackedInputState(session, now)).toBe('online');

    const replaced: TrackedSession = { startedBy: 'daemon', pid: 42, happySessionId: 'session-a' };
    expect(updateTrackedTransportHealth(replaced, 'session-a', 42,
      transportHealth({ processStartedAt: '2026-07-31T23:00:00.000Z' }), now)).toBe(true);
    expect(updateTrackedTransportHealth(replaced, 'session-a', 42,
      transportHealth({ generation: 3, processStartedAt: '2026-08-01T00:00:01.000Z' }), now)).toBe(false);

    const stale: TrackedSession = { startedBy: 'daemon', pid: 42, happySessionId: 'session-a' };
    expect(updateTrackedTransportHealth(stale, 'session-a', 42,
      transportHealth({ updatedAt: '2026-08-01T00:00:40.001Z' }), now)).toBe(false);
  });

  it('requires a newer proof and exact current-daemon child before recovery signals', () => {
    const baseline = transportHealth();
    expect(transportProofAdvanced(baseline, transportHealth({ generation: 3 }))).toBe(true);
    expect(transportProofAdvanced(baseline, transportHealth({ generation: 2 }))).toBe(false);
    const providerSessionId = '00000000-0000-4000-8000-000000000001';
    const child = { pid: 42, exitCode: null, signalCode: null } as TrackedSession['childProcess'];
    const tracked: TrackedSession = { startedBy: 'daemon', pid: 42, childProcess: child,
      happySessionId: 'session-a', expectedHappySessionId: 'session-a',
      resumeTarget: providerSessionId, observedProviderSessionId: providerSessionId };
    expect(isCurrentDaemonChild(tracked, 42)).toBe(true);
    expect(canResumeCurrentDaemonChild(tracked, 42, 'session-a', providerSessionId))
      .toBe(process.platform !== 'win32');
    expect(canResumeCurrentDaemonChild({ ...tracked, childProcess: undefined }, 42,
      'session-a', providerSessionId)).toBe(false);
    expect(canResumeCurrentDaemonChild({ ...tracked, startedBy: 'terminal' }, 42,
      'session-a', providerSessionId)).toBe(false);
    expect(canResumeCurrentDaemonChild({ ...tracked, tmuxSessionId: 'tmux:1' }, 42,
      'session-a', providerSessionId)).toBe(false);
    expect(canResumeCurrentDaemonChild({ ...tracked,
      childProcess: { ...child, exitCode: 0 } as TrackedSession['childProcess'] }, 42,
    'session-a', providerSessionId)).toBe(false);
    expect(canResumeCurrentDaemonChild({ ...tracked, observedProviderSessionId: 'other' }, 42,
      'session-a', providerSessionId)).toBe(false);
  });

  it('defers daemon upgrades for user sessions and never treats recovered PIDs as managed children', () => {
    const child = { pid: 42, exitCode: null, signalCode: null } as TrackedSession['childProcess'];
    const managed: TrackedSession = { startedBy: 'daemon', pid: 42, childProcess: child };
    expect(isDaemonManagedSession(managed)).toBe(true);
    expect(isDaemonManagedSession({ startedBy: 'daemon', pid: 42 })).toBe(false);
    expect(isDaemonManagedSession({ startedBy: 'daemon', pid: 42, tmuxSessionId: 'happy:1' })).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('resumes the exact stopped detached child and requires its newer proof', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => process.stdout.write("tick\\n"), 30)'],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    expect(child.pid).toBeTypeOf('number');
    const pid = child.pid!;
    const providerSessionId = '00000000-0000-4000-8000-000000000001';
    try {
      await once(child.stdout!, 'data');
      const before = new Date(), started = new Date(before.getTime() - 1_000).toISOString();
      const baseline = transportHealth({ processId: pid, processStartedAt: started,
        connectedAt: before.toISOString(), updatedAt: before.toISOString() });
      const tracked: TrackedSession = { startedBy: 'daemon', pid, childProcess: child,
        happySessionId: 'session-a', expectedHappySessionId: 'session-a',
        resumeTarget: providerSessionId, observedProviderSessionId: providerSessionId,
        transportHealth: baseline };
      process.kill(-pid, 'SIGSTOP');
      await new Promise(resolve => setTimeout(resolve, 100));
      child.stdout!.once('data', () => {
        const updatedAt = new Date().toISOString();
        tracked.transportHealth = transportHealth({ processId: pid, processStartedAt: started,
          connectedAt: updatedAt, updatedAt, generation: baseline.generation + 1 });
      });
      await expect(resumeCurrentDaemonChildProcess({ session: tracked, pid,
        happySessionId: 'session-a', providerSessionId, isCurrent: () => true,
        timeoutMs: 2_000, pollMs: 10 })).resolves.toBe('online');
      expect(child.pid).toBe(pid);
      expect(child.exitCode).toBeNull();
    } finally {
      try { process.kill(-pid, 'SIGCONT'); } catch { /* already resumed or exited */ }
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already exited */ }
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1_000))]);
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });
});

describe('runSerial', () => {
  it('preserves every same-session webhook in arrival order', async () => {
    const queues = new Map<string, Promise<void>>();
    const events: string[] = [];
    let release: (() => void) | undefined;
    const first = runSerial(queues, 'session-a', async () => {
      events.push('first:start');
      await new Promise<void>(resolve => { release = resolve; });
      events.push('first:end');
    });
    const second = runSerial(queues, 'session-a', async () => {
      events.push('second');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    release!();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
    expect(queues.size).toBe(0);
  });
});

describe('Codex restore profile authority', () => {
  it('accepts legacy records and binds a valid Codex profile to CODEX_HOME', () => {
    expect(parseRestoreFileData({ directory: '/workspace', agent: 'codex' }))
      .toEqual({ directory: '/workspace', agent: 'codex' });
    const restored = parseRestoreFileData({
      directory: '/workspace',
      agent: 'codex',
      codexProfile: 'eliasi',
    });
    expect(buildRestoreProfileEnvironment(restored)?.CODEX_HOME)
      .toMatch(/\/auth\/codex\/instances\/eliasi$/u);
  });

  it('rejects forged, unsafe, and non-Codex profile records', () => {
    expect(() => parseRestoreFileData({ directory: '/workspace', agent: 'claude', codexProfile: 'eliasi' }))
      .toThrow('Invalid restore authority');
    expect(() => parseRestoreFileData({ directory: '/workspace', agent: 'codex', codexProfile: '../eliasi' }))
      .toThrow('Invalid restore authority');
    expect(() => parseRestoreFileData({ directory: '/workspace', agent: 'codex', codexProfile: 'eliasi', extra: true }))
      .toThrow('Invalid restore authority');
  });
});

describe('trackedSessionMatchesIdentity', () => {
  it('owns both completed and pre-webhook restore identities', () => {
    expect(trackedSessionMatchesIdentity({
      startedBy: 'daemon',
      pid: 1,
      expectedHappySessionId: 'session-a',
    }, 'session-a')).toBe(true);
    expect(trackedSessionMatchesIdentity({
      startedBy: 'daemon',
      pid: 2,
      happySessionId: 'session-a',
    }, 'session-a')).toBe(true);
    expect(trackedSessionMatchesIdentity({
      startedBy: 'daemon',
      pid: 3,
      expectedHappySessionId: 'session-b',
    }, 'session-a')).toBe(false);
  });
});

describe('reconcileLiveTrackedSessionOwnership', () => {
  it('keeps the live restored process and removes a dead stale PID for the same session', () => {
    const sessions = new Map([
      [42, { startedBy: 'daemon', pid: 42, expectedHappySessionId: 'session-a' }],
      [99, { startedBy: 'happy directly', pid: 99, happySessionId: 'session-a' }],
    ]);

    expect(reconcileLiveTrackedSessionOwnership(sessions, 'session-a', (pid) => pid === 42))
      .toEqual({ owner: [42, sessions.get(42)], duplicates: [] });
    expect([...sessions.keys()]).toEqual([42]);
  });

  it('returns every extra live owner for fail-closed retirement', () => {
    const sessions = new Map<number, TrackedSession>([
      [99, { startedBy: 'happy directly', pid: 99, happySessionId: 'session-a' }],
      [43, { startedBy: 'daemon', pid: 43, expectedHappySessionId: 'session-a' }],
      [42, { startedBy: 'daemon', pid: 42, happySessionId: 'session-a' }],
    ]);

    expect(reconcileLiveTrackedSessionOwnership(sessions, 'session-a', () => true))
      .toEqual({ owner: [42, sessions.get(42)], duplicates: [
        [43, sessions.get(43)],
        [99, sessions.get(99)],
      ] });
  });
});

describe('sessionErrorLocalId', () => {
  it('is deterministic per visible event and changes across events', () => {
    const first = sessionErrorLocalId('session-a', 'event-a');
    expect(first).toMatch(/^xc-msg-v1-[a-f0-9]{64}$/u);
    expect(sessionErrorLocalId('session-a', 'event-a')).toBe(first);
    expect(sessionErrorLocalId('session-a', 'event-b')).not.toBe(first);
  });
});
