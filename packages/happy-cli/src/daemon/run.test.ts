import { describe, expect, it, vi } from 'vitest';
import type { TrackedSession } from './types';
import {
  buildDaemonSessionArgs,
  buildDaemonChildEnvironment,
  buildRestoreProfileEnvironment,
  classifyTrackedInputState,
  createSessionStartupDeadline,
  daemonHandoffHasUnrecoverableSessions,
  daemonHandoffIsBusy,
  DEFAULT_DAEMON_SESSION_AGENT,
  filterProfileEnvironmentVariablesForAgent,
  isDaemonManagedSession,
  isFreshDaemonSessionCandidate,
  isExactOnlineConsoleOwner,
  isProviderReadyForDaemonRegistration,
  isCurrentDaemonChild,
  isTrackedProviderRestoreReady,
  matchesExpectedHappySessionId,
  reconcileLiveTrackedSessionOwnership,
  recoverRestoredDaemonSessions,
  parseRestoreFileData,
  runSerial,
  selectTrackedConsoleSessions,
  sessionErrorLocalId,
  shutdownHasUnownedTargets,
  shouldRegisterMachineForSession,
  NEW_SESSION_REGISTRATION_TIMEOUT_MS,
  RESTORE_SESSION_STARTUP_TIMEOUT_MS,
  trackedSessionMatchesIdentity,
  updateTrackedProviderReadiness,
  waitForTrackedSessionStartup,
} from './run';

describe('session machine registration ownership', () => {
  it('leaves machine registration to the daemon for daemon-owned sessions only', () => {
    expect(shouldRegisterMachineForSession('daemon')).toBe(false);
    expect(shouldRegisterMachineForSession('terminal')).toBe(true);
    expect(shouldRegisterMachineForSession()).toBe(true);
  });
});

describe('daemon console ownership', () => {
  it('derives console children from the tracked-session authority', () => {
    const sessions = new Map<number, TrackedSession>([
      [41, { startedBy: 'daemon', pid: 41, isConsoleSession: true }],
      [42, { startedBy: 'daemon', pid: 42, happySessionId: 'session-a' }],
    ]);
    expect(selectTrackedConsoleSessions(sessions).map(([pid]) => pid)).toEqual([41]);
  });
});

describe('console restore ownership', () => {
  it('accepts only the exact online console owner', () => {
    const consoleOwner: TrackedSession = {
      startedBy: 'daemon',
      pid: 42,
      happySessionId: 'console-session',
      isConsoleSession: true,
      happySessionMetadataFromLocalWebhook: {
        path: '/tmp/console',
        host: 'host',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/lib',
        happyToolsDir: '/tmp/tools',
        consoleSession: true,
      },
    };

    expect(isExactOnlineConsoleOwner(consoleOwner, 'console-session')).toBe(true);
    expect(isExactOnlineConsoleOwner(consoleOwner, 'other-session')).toBe(false);
    expect(isExactOnlineConsoleOwner({ ...consoleOwner, isConsoleSession: false }, 'console-session')).toBe(false);
    expect(isExactOnlineConsoleOwner({
      ...consoleOwner,
      happySessionMetadataFromLocalWebhook: undefined,
      expectedHappySessionId: 'console-session',
    }, 'console-session')).toBe(false);
  });
});

describe('session startup deadline', () => {
  it('keeps new creation below the 30-second relay and restore below its 60-second relay', () => {
    expect(NEW_SESSION_REGISTRATION_TIMEOUT_MS).toBeLessThan(25_000);
    expect(RESTORE_SESSION_STARTUP_TIMEOUT_MS).toBeGreaterThan(50_000);
    expect(RESTORE_SESSION_STARTUP_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it('keeps one total input-readiness deadline', async () => {
    vi.useFakeTimers();
    try {
      let timedOut = false;
      createSessionStartupDeadline(() => { timedOut = true; }, NEW_SESSION_REGISTRATION_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(NEW_SESSION_REGISTRATION_TIMEOUT_MS - 1);
      expect(timedOut).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels completed starts', async () => {
    vi.useFakeTimers();
    try {
      let timedOut = false;
      const completed = createSessionStartupDeadline(
        () => { timedOut = true; },
        NEW_SESSION_REGISTRATION_TIMEOUT_MS,
      );
      completed.cancel();
      await vi.advanceTimersByTimeAsync(NEW_SESSION_REGISTRATION_TIMEOUT_MS);
      expect(timedOut).toBe(false);
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
        timeoutMs: NEW_SESSION_REGISTRATION_TIMEOUT_MS,
        register: value => { awaiter = value; },
        unregister: () => { registered = false; },
        terminate,
        complete: session => ({ type: 'success', sessionId: session.happySessionId! }),
      });

      expect(awaiter).toBeDefined();
      await vi.advanceTimersByTimeAsync(NEW_SESSION_REGISTRATION_TIMEOUT_MS);
      await expect(result).resolves.toEqual({
        type: 'error',
        errorMessage: 'Session startup timeout for PID 42',
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
        timeoutMs: NEW_SESSION_REGISTRATION_TIMEOUT_MS,
        register: () => {},
        unregister: () => {},
        terminate: async () => false,
        complete: session => ({ type: 'success', sessionId: session.happySessionId! }),
      });
      await vi.advanceTimersByTimeAsync(NEW_SESSION_REGISTRATION_TIMEOUT_MS);
      await expect(result).resolves.toEqual({
        type: 'error',
        errorMessage: 'Session startup timeout for PID 43 (tmux); process cleanup failed',
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
      timeoutMs: NEW_SESSION_REGISTRATION_TIMEOUT_MS,
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
        timeoutMs: NEW_SESSION_REGISTRATION_TIMEOUT_MS,
        register: value => { awaiter = value; },
        unregister: () => {},
        terminate: () => new Promise(resolve => { finishCleanup = resolve; }),
        complete: session => ({ type: 'success', sessionId: session.happySessionId! }),
      });

      await vi.advanceTimersByTimeAsync(NEW_SESSION_REGISTRATION_TIMEOUT_MS);
      awaiter!.resolve({ startedBy: 'daemon', pid: 45, happySessionId: 'late-session' });
      finishCleanup!(true);
      await expect(result).resolves.toEqual({
        type: 'error',
        errorMessage: 'Session startup timeout for PID 45',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

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

describe('isFreshDaemonSessionCandidate', () => {
  it('admits only a pending fresh daemon child, never a restore or external child', () => {
    expect(isFreshDaemonSessionCandidate({ startedBy: 'daemon' }, true)).toBe(true);
    expect(isFreshDaemonSessionCandidate({ startedBy: 'daemon' }, false)).toBe(false);
    expect(isFreshDaemonSessionCandidate({ startedBy: 'daemon',
      expectedHappySessionId: 'session-a' }, true)).toBe(false);
    expect(isFreshDaemonSessionCandidate({ startedBy: 'daemon',
      resumeTarget: '00000000-0000-4000-8000-000000000001' }, true)).toBe(false);
    expect(isFreshDaemonSessionCandidate({ startedBy: 'terminal' }, true)).toBe(false);
    expect(isFreshDaemonSessionCandidate(undefined, true)).toBe(false);
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
  it('uses final provider registration while old-daemon recovery stays unknown without it', () => {
    const ordinary: TrackedSession = { startedBy: 'daemon', pid: 42, happySessionId: 'session-a' };
    expect(classifyTrackedInputState(ordinary)).toBe('online');
    expect(classifyTrackedInputState({ ...ordinary, expectedHappySessionId: 'session-a' })).toBe('unknown');
    expect(classifyTrackedInputState({
      ...ordinary,
      expectedHappySessionId: 'session-a',
      happySessionMetadataFromLocalWebhook: {
        flavor: 'claude',
        path: '/workspace',
        host: 'host',
        homeDir: '/home',
        happyHomeDir: '/happy',
        happyLibDir: '/happy/lib',
        happyToolsDir: '/happy/tools',
      },
    })).toBe('online');
  });

  it('preserves ordinary shutdown and revalidates recovered ownership before destructive shutdown', () => {
    const child = { pid: 42, exitCode: null, signalCode: null } as TrackedSession['childProcess'];
    const managed: TrackedSession = { startedBy: 'daemon', pid: 42, childProcess: child };
    const recovered: TrackedSession = {
      startedBy: 'daemon',
      pid: 43,
      expectedHappySessionId: 'session-a',
    };
    expect(isDaemonManagedSession(managed)).toBe(true);
    expect(isDaemonManagedSession(recovered, [{ pid: 43, sessionId: 'session-a' }])).toBe(true);
    expect(isDaemonManagedSession(recovered, [{ pid: 43, sessionId: 'session-b' }])).toBe(false);
    expect(isDaemonManagedSession({ startedBy: 'daemon', pid: 42, tmuxSessionId: 'happy:1' })).toBe(true);
    expect(shutdownHasUnownedTargets(false, [{ startedBy: 'daemon', pid: 99 }])).toBe(false);
    expect(shutdownHasUnownedTargets(true, [{ startedBy: 'daemon', pid: 99 }])).toBe(true);
    expect(shutdownHasUnownedTargets(true, [recovered], [{ pid: 43, sessionId: 'session-a' }])).toBe(false);
    expect(daemonHandoffHasUnrecoverableSessions([recovered], [{ pid: 43, sessionId: 'session-a' }]))
      .toBe(false);
    expect(daemonHandoffHasUnrecoverableSessions([recovered], [])).toBe(true);
    expect(daemonHandoffHasUnrecoverableSessions([{ startedBy: 'terminal', pid: 44 }], [])).toBe(false);
    expect(daemonHandoffIsBusy(0, 0, 0)).toBe(false);
    expect(daemonHandoffIsBusy(1, 0, 0)).toBe(true);
    expect(daemonHandoffIsBusy(0, 1, 0)).toBe(true);
    expect(daemonHandoffIsBusy(0, 0, 1)).toBe(true);
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
