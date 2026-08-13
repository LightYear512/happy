import fs from 'fs/promises';
import os from 'os';
import { createHash } from 'node:crypto';

import { killProcessTree } from '@/utils/processKill';

import { ApiClient } from '@/api/api';
import { XC_VIRTUAL_SESSION_ID_PATTERN,
  type ObservedTrackedSession, type SessionInputState, type SessionTurnReport, type TrackedSession } from './types';
import { MachineMetadata, DaemonState, Metadata, type PermissionMode } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger, pruneLogDirectory } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock, readSettings, getActiveProfile, getEnvironmentVariables, validateProfileForAgent, getProfileEnvironmentVariables } from '@/persistence';

import { checkIfDaemonRunningAndCleanupStaleState, cleanupDaemonState } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { existsSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { getTmuxUtilities, isTmuxAvailable, parseTmuxSessionIdentifier, formatTmuxSessionIdentifier } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { getCodexInstancePath } from '@/commands/bang/ccsProfiles';
import { reportProjectError } from '@/utils/projectSessionStartup';
import { findAllHappyProcesses } from './doctor';

export function applyTrackedSessionTurn(session: TrackedSession, report: SessionTurnReport): boolean {
  if ((report.state === 'running') !== (report.token !== null)) return false;
  const prior = session.turn;
  if (prior?.sourceId && prior.sourceId !== report.sourceId) return false;
  if (prior && report.sequence < prior.sequence) return false;
  if (prior && report.sequence === prior.sequence) {
    return prior.state === report.state && prior.token === report.token;
  }
  session.turn = { ...report };
  return true;
}

// Restore file persistence for session auto-restore.
// Only stores immutable spawn params. sessionTag and claudeSessionId come from Server at restore time.
export interface RestoreFileData {
  directory: string;
  agent: 'claude' | 'codex' | 'gemini';
  titleAuthority?: 'external';
  codexProfile?: string;
}

export const DEFAULT_DAEMON_SESSION_AGENT: RestoreFileData['agent'] = 'claude';

export function matchesExpectedHappySessionId(expected: string | undefined, reported: string): boolean {
  return expected === undefined || expected === reported;
}

export function trackedSessionMatchesIdentity(session: TrackedSession, sessionId: string): boolean {
  return session.happySessionId === sessionId || session.expectedHappySessionId === sessionId;
}

export function reconcileLiveTrackedSessionOwnership(
  sessions: Map<number, TrackedSession>,
  sessionId: string,
  isProcessAlive: (pid: number) => boolean,
): { owner: [number, TrackedSession] | undefined; duplicates: Array<[number, TrackedSession]> } {
  const live: Array<[number, TrackedSession]> = [];
  for (const [pid, tracked] of sessions) {
    if (!trackedSessionMatchesIdentity(tracked, sessionId)) continue;
    if (!isProcessAlive(pid)) {
      sessions.delete(pid);
      continue;
    }
    live.push([pid, tracked]);
  }
  live.sort(([leftPid, left], [rightPid, right]) =>
    Number(right.startedBy === 'daemon') - Number(left.startedBy === 'daemon')
    || leftPid - rightPid);
  return { owner: live[0], duplicates: live.slice(1) };
}

export function runSerial<K, V>(
  queues: Map<K, Promise<void>>,
  key: K,
  start: () => Promise<V>,
): Promise<V> {
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(start);
  let tail: Promise<void>;
  tail = result.then(() => undefined, () => undefined).finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  queues.set(key, tail);
  return result;
}

// Mobile new-session RPCs have a 30-second Server relay budget. Leave enough
// time to terminate an unregistered child and return a structured error.
export const NEW_SESSION_REGISTRATION_TIMEOUT_MS = 20_000;
// Server-initiated restore has its own 60-second relay budget and must keep
// waiting for exact provider identity rather than publishing a false restore.
export const RESTORE_SESSION_STARTUP_TIMEOUT_MS = 58_000;

export function shouldRegisterMachineForSession(startedBy?: 'daemon' | 'terminal'): boolean {
  return startedBy !== 'daemon';
}

export function selectTrackedConsoleSessions(
  sessions: ReadonlyMap<number, TrackedSession>,
): Array<[number, TrackedSession]> {
  return Array.from(sessions.entries()).filter(([, tracked]) => tracked.isConsoleSession === true);
}

export function createSessionStartupDeadline(
  onTimeout: () => void,
  timeoutMs: number,
): { cancel: () => void } {
  let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timeout = null;
    onTimeout();
  }, timeoutMs);
  const cancel = () => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = null;
  };
  return { cancel };
}

export interface SessionStartupAwaiter {
  resolve: (session: TrackedSession) => void;
  cancel: () => void;
  fail: (errorMessage: string) => void;
}

export function waitForTrackedSessionStartup(input: {
  pid: number;
  suffix?: string;
  register: (awaiter: SessionStartupAwaiter) => void;
  unregister: () => void;
  terminate: () => Promise<boolean>;
  complete: (session: TrackedSession) => SpawnSessionResult;
  timeoutMs: number;
}): Promise<SpawnSessionResult> {
  return new Promise((resolve) => {
    let settled = false;
    let accepting = true;
    const settle = (result: SpawnSessionResult) => {
      if (settled) return;
      settled = true;
      accepting = false;
      deadline.cancel();
      input.unregister();
      resolve(result);
    };
    const failAfterCleanup = (message: string) => {
      if (!accepting) return;
      accepting = false;
      input.unregister();
      void Promise.resolve().then(input.terminate).then(
        terminated => settle({ type: 'error', errorMessage: terminated
          ? message : `${message}; process cleanup failed` }),
        () => settle({ type: 'error', errorMessage: `${message}; process cleanup failed` }),
      );
    };
    const deadline = createSessionStartupDeadline(() => {
      const message = `Session startup timeout for PID ${input.pid}${input.suffix ?? ''}`;
      failAfterCleanup(message);
    }, input.timeoutMs);
    input.register({
      resolve: (session) => {
        if (!accepting) return;
        try {
          settle(input.complete(session));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failAfterCleanup(message);
        }
      },
      cancel: () => { if (accepting) settle({ type: 'superseded' }); },
      fail: errorMessage => { if (accepting) settle({ type: 'error', errorMessage }); },
    });
  });
}

export function sessionErrorLocalId(sessionId: string, eventId: string): string {
  return `xc-msg-v1-${createHash('sha256').update(`${sessionId}\0${eventId}`).digest('hex')}`;
}

export function buildDaemonSessionArgs(
  options: SpawnSessionOptions,
  agent: RestoreFileData['agent'],
): string[] {
  const args = [agent, '--happy-starting-mode', 'remote', '--started-by', 'daemon'];
  if (options.resume) args.push('--resume', options.resume);
  if (options.restoreSessionId) args.push('--happy-restore-session', options.restoreSessionId);
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  return args;
}

const SAFE_HAPPY_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_CODEX_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CODEX_PROVIDER_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isProviderReadyForDaemonRegistration(
  metadata: Pick<Metadata, 'flavor' | 'startedBy' | 'claudeSessionId'>,
): boolean {
  return metadata.startedBy !== 'daemon'
    || metadata.flavor !== 'codex'
    || (typeof metadata.claudeSessionId === 'string'
      && CODEX_PROVIDER_SESSION_ID.test(metadata.claudeSessionId));
}

export function isFreshDaemonSessionCandidate(
  session: Pick<TrackedSession, 'startedBy' | 'expectedHappySessionId' | 'resumeTarget'> | undefined,
  hasPendingStartup: boolean,
): boolean {
  return hasPendingStartup
    && session?.startedBy === 'daemon'
    && session.expectedHappySessionId === undefined
    && session.resumeTarget === undefined;
}

export function isTrackedProviderRestoreReady(
  session: Pick<TrackedSession, 'expectedHappySessionId' | 'resumeTarget'>,
  metadata: Pick<Metadata, 'flavor'>,
  readyProviderSessionId: string | undefined,
): boolean {
  return session.expectedHappySessionId === undefined
    || session.resumeTarget === undefined
    || metadata.flavor !== 'codex'
    || readyProviderSessionId === session.resumeTarget;
}

export function updateTrackedProviderReadiness(
  session: Pick<TrackedSession, 'expectedHappySessionId' | 'resumeTarget' | 'observedProviderSessionId'>,
  metadata: Pick<Metadata, 'flavor' | 'claudeSessionId'>,
  readyProviderSessionId: string | undefined,
): { explicitMismatch: boolean; ready: boolean } {
  const proved = isTrackedProviderRestoreReady(session, metadata, readyProviderSessionId);
  const explicitMismatch = readyProviderSessionId !== undefined && !proved;
  if (!explicitMismatch) {
    const observed = readyProviderSessionId
      ?? (metadata.flavor === 'codex' ? undefined : metadata.claudeSessionId);
    if (typeof observed === 'string' && observed) session.observedProviderSessionId = observed;
  }
  return { explicitMismatch, ready: !explicitMismatch && (proved
    || (session.resumeTarget !== undefined && session.observedProviderSessionId === session.resumeTarget)) };
}

export function classifyTrackedInputState(session: TrackedSession): SessionInputState {
  const metadata = session.happySessionMetadataFromLocalWebhook;
  const providerIdentityReady = session.expectedHappySessionId === undefined
    || session.resumeTarget === undefined
    || metadata?.flavor !== 'codex'
    || session.observedProviderSessionId === session.resumeTarget;
  if (!providerIdentityReady) return 'unknown';
  return metadata !== undefined || session.expectedHappySessionId === undefined
    ? 'online'
    : 'unknown';
}

export function isExactOnlineConsoleOwner(session: TrackedSession, sessionId: string): boolean {
  return session.isConsoleSession === true
    && session.happySessionId === sessionId
    && classifyTrackedInputState(session) === 'online';
}

export function isCurrentDaemonChild(session: TrackedSession, pid: number): boolean {
  return session.startedBy === 'daemon'
    && session.tmuxSessionId === undefined
    && session.pid === pid
    && session.childProcess?.pid === pid
    && session.childProcess.exitCode === null
    && session.childProcess.signalCode === null;
}

function isCurrentDaemonTmuxWindow(session: TrackedSession, pid: number): boolean {
  return session.startedBy === 'daemon'
    && session.pid === pid
    && typeof session.tmuxSessionId === 'string'
    && session.tmuxSessionId.length > 0;
}

export function isDaemonManagedSession(
  session: TrackedSession,
  recovered: ReadonlyArray<{ pid: number; sessionId: string }> = [],
): boolean {
  return isCurrentDaemonChild(session, session.pid)
    || isCurrentDaemonTmuxWindow(session, session.pid)
    || (session.startedBy === 'daemon'
      && session.childProcess === undefined
      && session.tmuxSessionId === undefined
      && typeof session.expectedHappySessionId === 'string'
      && recovered.some(candidate => candidate.pid === session.pid
        && candidate.sessionId === session.expectedHappySessionId));
}

export function shutdownHasUnownedTargets(
  stopSessions: boolean,
  sessions: ReadonlyArray<TrackedSession>,
  recovered: ReadonlyArray<{ pid: number; sessionId: string }> = [],
): boolean {
  return stopSessions && sessions.some(session => !isDaemonManagedSession(session, recovered));
}

export function daemonHandoffHasUnrecoverableSessions(
  sessions: ReadonlyArray<TrackedSession>,
  recovered: ReadonlyArray<{ pid: number; sessionId: string }>,
): boolean {
  return sessions.some(session => session.startedBy === 'daemon'
    && !recovered.some(candidate => candidate.pid === session.pid
      && (candidate.sessionId === session.expectedHappySessionId
        || candidate.sessionId === session.happySessionId)));
}

export function daemonHandoffIsBusy(
  startupCount: number,
  lifecycleCount: number,
  webhookCount: number,
): boolean {
  return startupCount > 0 || lifecycleCount > 0 || webhookCount > 0;
}

export function recoverRestoredDaemonSessions(processes: Array<{ pid: number; command: string; type: string }>):
  Array<{ pid: number; sessionId: string }> {
  return processes.flatMap((process) => {
    if (!['daemon-spawned-session', 'dev-daemon-spawned'].includes(process.type)) return [];
    const matches = [...process.command.matchAll(
      /(?:^|\s)--happy-restore-session\s+([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?=\s|$)/gu)];
    return matches.length === 1 ? [{ pid: process.pid, sessionId: matches[0]![1]! }] : [];
  });
}

function isSafeHappySessionId(sessionId: string): boolean {
  return SAFE_HAPPY_SESSION_ID.test(sessionId);
}

function getRestoreDir(): string {
  return join(configuration.happyHomeDir, 'restore');
}

function getRestoreFilePath(sessionId: string): string {
  if (!isSafeHappySessionId(sessionId)) {
    throw new Error('Invalid Happy session ID');
  }
  return join(getRestoreDir(), `${sessionId}.json`);
}

function getClosedRestoreFilePath(sessionId: string): string {
  if (!isSafeHappySessionId(sessionId)) {
    throw new Error('Invalid Happy session ID');
  }
  return join(getRestoreDir(), `${sessionId}.closed`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeRestoreFile(sessionId: string, data: RestoreFileData): Promise<void> {
  const dir = getRestoreDir();
  await fs.mkdir(dir, { recursive: true });
  if (await pathExists(getClosedRestoreFilePath(sessionId))) {
    return;
  }
  let existingProfile: string | undefined;
  try {
    const current = parseRestoreFileData(JSON.parse(await fs.readFile(getRestoreFilePath(sessionId), 'utf-8')));
    existingProfile = current.codexProfile;
  } catch { /* first write or legacy invalid file */ }
  const codexProfile = data.codexProfile ?? existingProfile;
  await fs.writeFile(getRestoreFilePath(sessionId), JSON.stringify({
    ...data,
    ...(codexProfile ? { codexProfile } : {}),
  }), 'utf-8');
}

export function parseRestoreFileData(value: unknown): RestoreFileData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid restore authority');
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.some((key) => !['agent', 'directory', 'titleAuthority', 'codexProfile'].includes(key))
    || typeof row.directory !== 'string' || !row.directory
    || !['claude', 'codex', 'gemini'].includes(String(row.agent))
    || (row.titleAuthority !== undefined && row.titleAuthority !== 'external')
    || (row.codexProfile !== undefined && (row.agent !== 'codex'
      || typeof row.codexProfile !== 'string' || !SAFE_CODEX_PROFILE.test(row.codexProfile)))) {
    throw new Error('Invalid restore authority');
  }
  return { directory: row.directory, agent: row.agent as RestoreFileData['agent'],
    ...(row.titleAuthority === 'external' ? { titleAuthority: 'external' as const } : {}),
    ...(typeof row.codexProfile === 'string' ? { codexProfile: row.codexProfile } : {}) };
}

export function buildRestoreProfileEnvironment(
  data: RestoreFileData,
): { CODEX_HOME: string } | undefined {
  return data.agent === 'codex' && data.codexProfile
    ? { CODEX_HOME: getCodexInstancePath(data.codexProfile) }
    : undefined;
}

async function updateRestoreCodexProfile(sessionId: string, profileName: string): Promise<boolean> {
  if (!isSafeHappySessionId(sessionId) || !SAFE_CODEX_PROFILE.test(profileName)
    || await pathExists(getClosedRestoreFilePath(sessionId))) return false;
  const current = await readRestoreFile(sessionId);
  if (!current || current.agent !== 'codex'
    || !existsSync(join(getCodexInstancePath(profileName), 'auth.json'))) return false;
  await writeRestoreFile(sessionId, { ...current, codexProfile: profileName });
  return true;
}

async function readRestoreFile(sessionId: string): Promise<RestoreFileData | null> {
  try {
    if (await pathExists(getClosedRestoreFilePath(sessionId))) {
      return null;
    }
    const content = await fs.readFile(getRestoreFilePath(sessionId), 'utf-8');
    return parseRestoreFileData(JSON.parse(content));
  } catch {
    return null;
  }
}

async function reopenRestoreFile(
  sessionId: string,
): Promise<{ state: 'reopened' | 'already-open'; data: RestoreFileData }> {
  const restorePath = getRestoreFilePath(sessionId);
  const closedPath = getClosedRestoreFilePath(sessionId);
  const closed = await pathExists(closedPath);
  const open = await pathExists(restorePath);
  if (closed && open) {
    throw new Error('Conflicting open and closed restore authority');
  }
  const source = closed ? closedPath : open ? restorePath : null;
  if (!source) {
    throw new Error('Closed-session restore authority is missing');
  }
  const data = parseRestoreFileData(JSON.parse(await fs.readFile(source, 'utf-8')));
  if (closed) {
    await fs.rename(closedPath, restorePath);
    return { state: 'reopened', data };
  }
  return { state: 'already-open', data };
}

async function closeRestoreFile(sessionId: string, createIfMissing: boolean): Promise<'closed' | 'already-closed' | 'missing'> {
  const restorePath = getRestoreFilePath(sessionId);
  const closedPath = getClosedRestoreFilePath(sessionId);
  await fs.mkdir(getRestoreDir(), { recursive: true });

  if (await pathExists(closedPath)) {
    await fs.rm(restorePath, { force: true });
    return 'already-closed';
  }

  try {
    await fs.rename(restorePath, closedPath);
    return 'closed';
  } catch (error) {
    if (await pathExists(closedPath)) {
      await fs.rm(restorePath, { force: true });
      return 'already-closed';
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (createIfMissing) {
        try {
          await fs.writeFile(closedPath, '', { flag: 'wx' });
        } catch (writeError) {
          if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw writeError;
          }
        }
        return 'closed';
      }
      return 'missing';
    }
    throw error;
  }
}

// Prepare initial metadata
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname(),
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath()
};

const CODEX_PROFILE_MODEL_ENV_KEYS = new Set([
  'OPENAI_MODEL',
  'OPENAI_SMALL_FAST_MODEL',
  'CODEX_MODEL',
  'CODEX_SMALL_FAST_MODEL',
]);

export function filterProfileEnvironmentVariablesForAgent(
  envVars: Record<string, string>,
  agentType: 'claude' | 'codex' | 'gemini',
): Record<string, string> {
  if (agentType !== 'codex') {
    return envVars;
  }

  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (CODEX_PROFILE_MODEL_ENV_KEYS.has(key)) {
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
}

export function buildDaemonChildEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string>,
  agentType: RestoreFileData['agent'],
  resume?: string,
): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) childEnv[key] = value;
  }
  if (agentType === 'codex') {
    delete childEnv.CODEX_THREAD_ID;
    if (extraEnv.CODEX_HOME === undefined) delete childEnv.CODEX_HOME;
  }
  if (extraEnv.HAPPY_RESUME_TITLE === undefined) delete childEnv.HAPPY_RESUME_TITLE;
  if (extraEnv.HAPPY_TITLE_AUTHORITY === undefined) delete childEnv.HAPPY_TITLE_AUTHORITY;
  return { ...childEnv, ...extraEnv };
}

// Get environment variables for a profile, filtered for agent compatibility
async function getProfileEnvironmentVariablesForAgent(
  profileId: string,
  agentType: 'claude' | 'codex' | 'gemini'
): Promise<Record<string, string>> {
  try {
    const settings = await readSettings();
    const profile = settings.profiles.find(p => p.id === profileId);

    if (!profile) {
      logger.debug(`[DAEMON RUN] Profile ${profileId} not found`);
      return {};
    }

    // Check if profile is compatible with the agent
    if (!validateProfileForAgent(profile, agentType)) {
      logger.debug(`[DAEMON RUN] Profile ${profileId} not compatible with agent ${agentType}`);
      return {};
    }

    // Get environment variables from profile (new schema)
    const envVars = filterProfileEnvironmentVariablesForAgent(
      getProfileEnvironmentVariables(profile),
      agentType,
    );

    logger.debug(`[DAEMON RUN] Loaded ${Object.keys(envVars).length} environment variables from profile ${profileId} for agent ${agentType}`);
    return envVars;
  } catch (error) {
    logger.debug('[DAEMON RUN] Failed to get profile environment variables:', error);
    return {};
  }
}

export async function startDaemon(): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  // Cancelled by cleanupAndShutdown when it actually starts running (indicating
  // graceful shutdown is in progress). A separate hard-exit watchdog with a more
  // generous timeout covers the case where cleanup itself wedges.
  let startupMalfunctionTimer: NodeJS.Timeout | null = null;
  // Set true by cleanupAndShutdown so restoreSession RPC from server rejects
  // new work during the shutdown window.
  let shuttingDown = false;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      if (startupMalfunctionTimer) return;
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case graceful cleanup never kicks in (e.g. signal arrived
      // before startup finished), we will force exit. Bumped to 15s so a normal
      // --kill-sessions path with taskkill + session-end flush has room to run.
      // cleanupAndShutdown clears this timer on entry so the happy path is free.
      startupMalfunctionTimer = setTimeout(async () => {
        logger.debug('[DAEMON RUN] Shutdown watchdog fired, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 15_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  // A running daemon is the sole lifecycle owner. Ordinary CLI/session startup
  // must never replace it merely because another installed CLI has a different
  // version; explicit daemon stop/start performs upgrades without version ping-pong.
  const daemonRunning = await checkIfDaemonRunningAndCleanupStaleState();
  if (daemonRunning) {
    logger.debug('[DAEMON RUN] Daemon already running; keeping the current lifecycle owner');
    console.log('Daemon already running');
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
    process.exit(0);
  }

  void pruneLogDirectory(configuration.logsDir, logger.logFilePath)
    .catch(error => logger.debug('[DAEMON RUN] Failed to prune logs', error));

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // Ensure auth and machine registration BEFORE anything else
    const { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, SessionStartupAwaiter>();
    const closingSessionIds = new Set<string>();
    const lifecycleQueue = new Map<string, Promise<void>>();
    const webhookQueue = new Map<string, Promise<void>>();
    let sendSessionEnd: ((sessionId: string) => void) | null = null;
    let restoreControlSession: (sessionId: string, permissionMode?: PermissionMode) => Promise<SpawnSessionResult & {
      agent?: RestoreFileData['agent'];
    }> = async () => ({ type: 'error', errorMessage: 'Happy daemon is still starting' });
    let replaceControlSession: (input: { previousSessionId: string; providerSessionId: string;
      virtualSessionId: string; title: string }) => Promise<SpawnSessionResult & {
        agent?: RestoreFileData['agent'];
      }> = async () => ({ type: 'error', errorMessage: 'Happy daemon is still starting' });

    const isProcessAlive = (pid: number): boolean => {
      if (!Number.isFinite(pid) || pid <= 1) {
        return false;
      }
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const recoveredSessions = recoverRestoredDaemonSessions(await findAllHappyProcesses());

    const waitForProcessExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) {
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return !isProcessAlive(pid);
    };

    const terminateTrackedSession = async (pid: number, session: TrackedSession): Promise<boolean> => {
      if (pidToTrackedSession.get(pid) !== session) {
        logger.debug(`[DAEMON RUN] Refusing to signal unowned session PID ${pid}`);
        return false;
      }
      if (isCurrentDaemonTmuxWindow(session, pid)) {
        const killed = await getTmuxUtilities().killWindow(session.tmuxSessionId!);
        if ((!killed && isProcessAlive(pid)) || !await waitForProcessExit(pid, 1000)) return false;
        if (pidToTrackedSession.get(pid) === session) pidToTrackedSession.delete(pid);
        return true;
      }
      const managed = isCurrentDaemonChild(session, pid) || isDaemonManagedSession(
        session,
        recoverRestoredDaemonSessions(await findAllHappyProcesses()),
      );
      if (!managed) {
        logger.debug(`[DAEMON RUN] Refusing to signal unowned session PID ${pid}`);
        return false;
      }
      try {
        await killProcessTree(pid);
      } catch (error) {
        logger.debug(`[DAEMON RUN] Failed to signal session PID ${pid}:`, error);
      }
      const gracefulExitMs = session.startedBy === 'daemon' ? 3000 : 1000;
      if (await waitForProcessExit(pid, gracefulExitMs)) {
        pidToTrackedSession.delete(pid);
        return true;
      }

      if (pidToTrackedSession.get(pid) !== session || !isCurrentDaemonChild(session, pid)) return false;
      try { process.kill(-pid, 'SIGKILL'); } catch { /* process group may already be gone */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* process may already be gone */ }
      if (await waitForProcessExit(pid, 1000)) {
        pidToTrackedSession.delete(pid);
        return true;
      }

      logger.debug(`[DAEMON RUN] Daemon-owned session PID ${pid} remained alive after SIGKILL`);
      return false;
    };

    const retireDuplicateTrackedSessionOwners = async (sessionId: string) => {
      const ownership = reconcileLiveTrackedSessionOwnership(pidToTrackedSession, sessionId, isProcessAlive);
      for (const [duplicatePid, duplicate] of ownership.duplicates) {
        const duplicateAwaiter = pidToAwaiter.get(duplicatePid);
        if (duplicateAwaiter) {
          pidToAwaiter.delete(duplicatePid);
          duplicateAwaiter.cancel();
        }
      }
      const results = await Promise.all(ownership.duplicates.map(
        ([duplicatePid, duplicate]) => terminateTrackedSession(duplicatePid, duplicate)));
      for (const [index, terminated] of results.entries()) {
        if (!terminated) {
          const [duplicatePid, duplicate] = ownership.duplicates[index]!;
          pidToTrackedSession.set(duplicatePid, duplicate);
        }
      }
      const clean = results.every(Boolean);
      return { ...ownership, clean };
    };

    for (const recovered of recoveredSessions) {
      if (!isProcessAlive(recovered.pid)) continue;
      pidToTrackedSession.set(recovered.pid, { startedBy: 'daemon', happySessionId: recovered.sessionId,
        expectedHappySessionId: recovered.sessionId, pid: recovered.pid });
      logger.debug(`[DAEMON RUN] Recovered live restored session ${recovered.sessionId} (PID ${recovered.pid})`);
    }
    for (const sessionId of new Set(recoveredSessions.map(session => session.sessionId))) {
      if (existsSync(getClosedRestoreFilePath(sessionId))) {
        const results = await Promise.all(Array.from(pidToTrackedSession.entries())
          .filter(([, session]) => trackedSessionMatchesIdentity(session, sessionId))
          .map(([pid, session]) => terminateTrackedSession(pid, session)));
        if (results.some(result => !result)) {
          logger.debug(`[DAEMON RUN] Closed recovered session ${sessionId} could not be fully terminated`);
        }
        continue;
      }
      const ownership = await retireDuplicateTrackedSessionOwners(sessionId);
      if (!ownership.clean) {
        logger.debug(`[DAEMON RUN] Recovered ownership conflict for ${sessionId} could not be retired`);
      }
    }

    const matchingTrackedSessions = (sessionId: string): Array<[number, TrackedSession]> => {
      const pidMatch = /^PID-([1-9][0-9]*)$/.exec(sessionId);
      if (pidMatch) {
        const pid = Number(pidMatch[1]);
        const tracked = pidToTrackedSession.get(pid);
        return tracked ? [[pid, tracked]] : [];
      }
      return Array.from(pidToTrackedSession.entries())
        .filter(([, tracked]) => trackedSessionMatchesIdentity(tracked, sessionId));
    };

    const terminateSession = async (sessionId: string): Promise<boolean> => {
      const matches = matchingTrackedSessions(sessionId);
      if (matches.length === 0) {
        return false;
      }
      const results = await Promise.all(matches.map(([pid, tracked]) => terminateTrackedSession(pid, tracked)));
      return results.every(Boolean);
    };

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());
    const getObservedChildren = (): ObservedTrackedSession[] => getCurrentChildren()
      .map((child) => ({ ...child, inputState: classifyTrackedInputState(child) }));

    // Handle webhook from happy session reporting itself
    const processHappySessionWebhook = async (
      sessionId: string,
      sessionMetadata: Metadata,
      readyProviderSessionId?: string,
      turn?: SessionTurnReport,
    ) => {
      logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

      if (!isSafeHappySessionId(sessionId)) {
        logger.debug(`[DAEMON RUN] Rejecting webhook with unsafe session id: ${sessionId}`);
        return;
      }
      const reportedPid = sessionMetadata.hostPid;
      if (!reportedPid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }
      const reportedSession = pidToTrackedSession.get(reportedPid);
      const acceptsFreshCandidate = isFreshDaemonSessionCandidate(
        reportedSession,
        pidToAwaiter.has(reportedPid),
      ) && (isCurrentDaemonChild(reportedSession!, reportedPid)
        || isCurrentDaemonTmuxWindow(reportedSession!, reportedPid));
      if (!isProviderReadyForDaemonRegistration(sessionMetadata) && !acceptsFreshCandidate) {
        logger.debug(`[DAEMON RUN] Deferring daemon Codex webhook without a durable provider identity: ${sessionId}`);
        return;
      }

      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${reportedPid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
      logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      const ownership = await retireDuplicateTrackedSessionOwners(sessionId);
      if (!ownership.clean) {
        logger.debug(`[DAEMON RUN] Ownership conflict for ${sessionId}: a duplicate process could not be terminated`);
        return;
      }
      if (ownership.duplicates.some(([duplicatePid]) => duplicatePid === reportedPid)) {
        logger.debug(`[DAEMON RUN] Rejected duplicate live owner PID ${reportedPid} for ${sessionId}`);
        return;
      }
      const owner = ownership.owner;
      const pid = owner?.[0] ?? reportedPid;
      const existingSession = owner?.[1] ?? pidToTrackedSession.get(reportedPid);
      if (pid !== reportedPid) {
        logger.debug(`[DAEMON RUN] Reconciled stale reported PID ${reportedPid} to tracked PID ${pid} for ${sessionId}`);
      }

      if (closingSessionIds.has(sessionId) || existsSync(getClosedRestoreFilePath(sessionId))) {
        logger.debug(`[DAEMON RUN] Rejecting late webhook for closing session ${sessionId} (PID ${pid})`);
        if (existingSession?.startedBy === 'daemon') {
          existingSession.happySessionId = sessionId;
          const awaiter = pidToAwaiter.get(pid);
          if (awaiter) {
            pidToAwaiter.delete(pid);
            awaiter.cancel();
          }
          void terminateTrackedSession(pid, existingSession);
        }
        return;
      }

      let readyStartup: { pid: number; awaiter: SessionStartupAwaiter; session: TrackedSession }
        | undefined;
      if (existingSession && existingSession.startedBy === 'daemon') {
        if (!matchesExpectedHappySessionId(existingSession.expectedHappySessionId, sessionId)) {
          logger.debug(`[DAEMON RUN] Restore identity mismatch: expected ${existingSession.expectedHappySessionId}, received ${sessionId}`);
          void (async () => {
            const terminated = await terminateTrackedSession(pid, existingSession);
            const awaiter = pidToAwaiter.get(pid);
            if (awaiter) {
              pidToAwaiter.delete(pid);
              awaiter.cancel();
            }
            if (!terminated) {
              logger.debug(`[DAEMON RUN] Failed to terminate mismatched restore process PID ${pid}`);
            }
          })();
          return;
        }
        // Update daemon-spawned session with reported data
        existingSession.happySessionId = sessionId;
        existingSession.happySessionMetadataFromLocalWebhook = { ...sessionMetadata, hostPid: pid };
        existingSession.isConsoleSession = existingSession.isConsoleSession || sessionMetadata.consoleSession === true;
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

        const readiness = updateTrackedProviderReadiness(
          existingSession,
          sessionMetadata,
          readyProviderSessionId,
        );
        if (readiness.explicitMismatch) {
          const awaiter = pidToAwaiter.get(pid);
          if (awaiter) {
            pidToAwaiter.delete(pid);
            awaiter.fail('Restored provider identity mismatch');
          }
          void terminateTrackedSession(pid, existingSession);
          return;
        }

        const awaiter = pidToAwaiter.get(pid);
        if (awaiter && readiness.ready && classifyTrackedInputState(existingSession) === 'online') {
          readyStartup = { pid, awaiter, session: existingSession };
        } else if (awaiter) {
          logger.debug(`[DAEMON RUN] Waiting for provider restore readiness for PID ${pid}`);
        }
      } else if (existingSession) {
        existingSession.happySessionMetadataFromLocalWebhook = { ...sessionMetadata, hostPid: pid };
        existingSession.isConsoleSession = existingSession.isConsoleSession || sessionMetadata.consoleSession === true;
        updateTrackedProviderReadiness(existingSession, sessionMetadata, readyProviderSessionId);
      } else {
        // New session started externally
        const trackedSession: TrackedSession = {
          startedBy: 'happy directly - likely by user from terminal',
          happySessionId: sessionId,
          happySessionMetadataFromLocalWebhook: sessionMetadata,
          observedProviderSessionId: sessionMetadata.claudeSessionId,
          pid,
          isConsoleSession: sessionMetadata.consoleSession === true,
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
      }

      // Persist restore file for any session (daemon-spawned or external).
      // Skip console sessions — they should not be restorable (would cause multiple consoles).
      const tracked = pidToTrackedSession.get(pid);
      if (tracked && turn && !applyTrackedSessionTurn(tracked, turn)) {
        logger.debug(`[DAEMON RUN] Ignored stale turn snapshot for ${sessionId} sequence=${turn.sequence}`);
      }
      if (sessionId && sessionMetadata.path && !tracked?.isConsoleSession && sessionMetadata.consoleSession !== true) {
        const agent = (sessionMetadata.flavor === 'codex' ? 'codex' : sessionMetadata.flavor === 'gemini' ? 'gemini' : 'claude') as 'claude' | 'codex' | 'gemini';
        try {
          await writeRestoreFile(sessionId, {
            directory: sessionMetadata.path,
            agent,
            ...(sessionMetadata.titleAuthority === 'external' ? { titleAuthority: 'external' as const } : {}),
          });
        } catch (error) {
          logger.debug(`[DAEMON RUN] Failed to write restore file for ${sessionId}: ${error}`);
          if (readyStartup) {
            pidToAwaiter.delete(readyStartup.pid);
            readyStartup.awaiter.fail('Failed to persist session restore authority');
            void terminateTrackedSession(readyStartup.pid, readyStartup.session);
          }
          return;
        }
      } else if (readyStartup && !tracked?.isConsoleSession) {
        pidToAwaiter.delete(readyStartup.pid);
        readyStartup.awaiter.fail('Session restore authority is missing a working directory');
        void terminateTrackedSession(readyStartup.pid, readyStartup.session);
        return;
      }

      if (readyStartup) {
        pidToAwaiter.delete(readyStartup.pid);
        readyStartup.awaiter.resolve(readyStartup.session);
        logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${readyStartup.pid}`);
      }
    };

    const onHappySessionWebhook = (
      sessionId: string,
      sessionMetadata: Metadata,
      readyProviderSessionId?: string,
      turn?: SessionTurnReport,
    ): Promise<void> => runSerial(webhookQueue, sessionId, () => processHappySessionWebhook(
      sessionId, sessionMetadata, readyProviderSessionId, turn));

    const onSessionTurn = async (sessionId: string, pid: number, turn: SessionTurnReport): Promise<boolean> => {
      const matches = matchingTrackedSessions(sessionId);
      if (matches.length !== 1 || matches[0]![0] !== pid || !isProcessAlive(pid)) return false;
      const tracked = matches[0]![1];
      return pidToTrackedSession.get(pid) === tracked && applyTrackedSessionTurn(tracked, turn);
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[DAEMON RUN] Spawning session', options);

      if (shuttingDown) return { type: 'error', errorMessage: 'Daemon is shutting down' };

      const sessionAgent = options.agent || DEFAULT_DAEMON_SESSION_AGENT;
      if (options.restoreSessionId && sessionAgent === 'gemini') {
        return {
          type: 'error',
          errorMessage: 'Gemini session restore is unavailable. Create a new session explicitly.',
        };
      }

      // Validate resume session ID format (UUID) to prevent injection in tmux string concatenation
      if (options.resume && !CODEX_PROVIDER_SESSION_ID.test(options.resume)) {
        logger.debug(`[DAEMON RUN] Invalid resume session ID format: ${options.resume}`);
        return { type: 'error', errorMessage: `Invalid resume session ID format: ${options.resume}` };
      }
      if (options.xcReplacement && (options.resume !== options.xcReplacement.providerBinding
        || !XC_VIRTUAL_SESSION_ID_PATTERN.test(options.xcReplacement.sessionId)
        || !isSafeHappySessionId(options.xcReplacement.previousOpener))) {
        return { type: 'error', errorMessage: 'Invalid XC provider replacement provenance' };
      }

      const { directory, sessionId, machineId, approvedNewDirectoryCreation = true } = options;
      let directoryCreated = false;

      try {
        await fs.access(directory);
        logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
      } catch (error) {
        logger.debug(`[DAEMON RUN] Directory doesn't exist, creating: ${directory}`);

        // Check if directory creation is approved
        if (!approvedNewDirectoryCreation) {
          logger.debug(`[DAEMON RUN] Directory creation not approved for: ${directory}`);
          return {
            type: 'requestToApproveDirectoryCreation',
            directory
          };
        }

        try {
          await fs.mkdir(directory, { recursive: true });
          logger.debug(`[DAEMON RUN] Successfully created directory: ${directory}`);
          directoryCreated = true;
        } catch (mkdirError: any) {
          let errorMessage = `Unable to create directory at '${directory}'. `;

          // Provide more helpful error messages based on the error code
          if (mkdirError.code === 'EACCES') {
            errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
          } else if (mkdirError.code === 'ENOTDIR') {
            errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
          } else if (mkdirError.code === 'ENOSPC') {
            errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
          } else if (mkdirError.code === 'EROFS') {
            errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
          } else {
            errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
          }

          logger.debug(`[DAEMON RUN] Directory creation failed: ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }
      }

      try {

        // Build environment variables with explicit precedence layers:
        // Layer 1 (base): Authentication tokens - protected, cannot be overridden
        // Layer 2 (middle): Profile environment variables - GUI profile OR CLI local profile
        // Layer 3 (top): Auth tokens again to ensure they're never overridden

        // Layer 1: Resolve authentication token if provided
        const authEnv: Record<string, string> = {};
        if (options.token) {
          if (options.agent === 'codex') {
            // Persist codex auth to a stable instance directory so auth survives
            // process restarts and aligns with !auth / !login paths.
            // Derive instance name from account_id in the token JSON (falls back to "default").
            let instanceName = 'default';
            try {
              const parsed = JSON.parse(options.token);
              if (parsed?.tokens?.account_id) {
                instanceName = parsed.tokens.account_id;
              }
            } catch { /* use default */ }

            const codexHome = getCodexInstancePath(instanceName);
            await fs.mkdir(codexHome, { recursive: true });
            await fs.writeFile(join(codexHome, 'auth.json'), options.token);
            authEnv.CODEX_HOME = codexHome;
            logger.debug(`[DAEMON RUN] Wrote codex auth to persistent instance: ${codexHome}`);
          } else { // Assuming claude
            authEnv.CLAUDE_CODE_OAUTH_TOKEN = options.token;
          }
        }

        // Layer 2: Profile environment variables
        // Priority: GUI-provided profile > CLI local active profile > none
        let profileEnv: Record<string, string> = {};

        if (options.environmentVariables && Object.keys(options.environmentVariables).length > 0) {
          // GUI provided profile environment variables - highest priority for profile settings
          profileEnv = options.environmentVariables;
          logger.info(`[DAEMON RUN] Using GUI-provided profile environment variables (${Object.keys(profileEnv).length} vars)`);
          logger.debug(`[DAEMON RUN] GUI profile env var keys: ${Object.keys(profileEnv).join(', ')}`);
        } else {
          // Fallback to CLI local active profile
          try {
            const settings = await readSettings();
            if (settings.activeProfileId) {
              logger.debug(`[DAEMON RUN] No GUI profile provided, loading CLI local active profile: ${settings.activeProfileId}`);

              // Get profile environment variables filtered for agent compatibility
              const profileAgent = options.agent || DEFAULT_DAEMON_SESSION_AGENT;
              profileEnv = await getProfileEnvironmentVariablesForAgent(
                settings.activeProfileId,
                profileAgent
              );

              logger.debug(`[DAEMON RUN] Loaded ${Object.keys(profileEnv).length} environment variables from CLI local profile for agent ${profileAgent}`);
              logger.debug(`[DAEMON RUN] CLI profile env var keys: ${Object.keys(profileEnv).join(', ')}`);
            } else {
              logger.debug('[DAEMON RUN] No CLI local active profile set');
            }
          } catch (error) {
            logger.debug('[DAEMON RUN] Failed to load CLI local profile environment variables:', error);
            // Continue without profile env vars - this is not a fatal error
          }
        }

        // Final merge: Profile vars first, then auth (auth takes precedence to protect authentication)
        let extraEnv = { ...profileEnv, ...authEnv };
        if (options.xcReplacement) {
          extraEnv = { ...extraEnv,
            XC_REPLACEMENT_SESSION_ID: options.xcReplacement.sessionId,
            XC_REPLACEMENT_PREVIOUS_OPENER: options.xcReplacement.previousOpener,
            XC_REPLACEMENT_PROVIDER_BINDING: options.xcReplacement.providerBinding,
          };
        }
        logger.debug(`[DAEMON RUN] Final environment variable keys (before expansion) (${Object.keys(extraEnv).length}): ${Object.keys(extraEnv).join(', ')}`);

        // Expand ${VAR} references from daemon's process.env
        // This ensures variable substitution works in both tmux and non-tmux modes
        // Example: ANTHROPIC_AUTH_TOKEN="${Z_AI_AUTH_TOKEN}" → ANTHROPIC_AUTH_TOKEN="sk-real-key"
        extraEnv = expandEnvironmentVariables(extraEnv, process.env);
        logger.debug(`[DAEMON RUN] After variable expansion: ${Object.keys(extraEnv).join(', ')}`);

        // Mark console session so the child process can use a deterministic tag and custom name
        if (options.consoleSession) {
          extraEnv = { ...extraEnv, HAPPY_CONSOLE_SESSION: '1' };
        }

        // Pass resume title so the new session can restore it
        if (options.title) {
          extraEnv = { ...extraEnv, HAPPY_RESUME_TITLE: options.title };
        }
        if (options.titleAuthority === 'external') {
          extraEnv = { ...extraEnv, HAPPY_TITLE_AUTHORITY: 'external' };
        }

        // Fail-fast validation: Check that any auth variables present are fully expanded
        // Only validate variables that are actually set (different agents need different auth)
        const potentialAuthVars = ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_HOME', 'AZURE_OPENAI_API_KEY', 'TOGETHER_API_KEY'];
        const unexpandedAuthVars = potentialAuthVars.filter(varName => {
          const value = extraEnv[varName];
          // Only fail if variable IS SET and contains unexpanded ${VAR} references
          return value && typeof value === 'string' && value.includes('${');
        });

        if (unexpandedAuthVars.length > 0) {
          // Extract the specific missing variable names from unexpanded references
          const missingVarDetails = unexpandedAuthVars.map(authVar => {
            const value = extraEnv[authVar];
            const unresolvedMatch = value?.match(/\$\{([A-Z_][A-Z0-9_]*)(:-[^}]*)?\}/);
            const missingVar = unresolvedMatch ? unresolvedMatch[1] : 'unknown';
            return `${authVar} references \${${missingVar}} which is not defined`;
          });

          const errorMessage = `Authentication will fail - environment variables not found in daemon: ${missingVarDetails.join('; ')}. ` +
            `Ensure these variables are set in the daemon's environment (not just your shell) before starting sessions.`;
          logger.warn(`[DAEMON RUN] ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }

        // Kill stale processes before spawning when resuming the same Claude session
        if (options.resume) {
          const staleEntries: Array<[number, TrackedSession]> = [];
          for (const [pid, session] of pidToTrackedSession) {
            if (session.resumeTarget === options.resume ||
                session.happySessionMetadataFromLocalWebhook?.claudeSessionId === options.resume) {
              staleEntries.push([pid, session]);
            }
          }

          for (const [pid, session] of staleEntries) {
            logger.debug(`[DAEMON RUN] Killing stale session PID ${pid} before resume ${options.resume}`);
            const pendingAwaiter = pidToAwaiter.get(pid);
            if (pendingAwaiter) {
              pidToAwaiter.delete(pid);
              pendingAwaiter.cancel();
              logger.debug(`[DAEMON RUN] Cancelled pending awaiter for superseded PID ${pid}`);
            }
            if (!await terminateTrackedSession(pid, session)) {
              return { type: 'error', errorMessage:
                `Stale session PID ${pid} could not be terminated before resume` };
            }
            if (session.happySessionId && sendSessionEnd) {
              sendSessionEnd(session.happySessionId);
              logger.debug(`[DAEMON RUN] Sent session-end for stale session ${session.happySessionId}`);
            }
          }

          if (staleEntries.length > 0) {
            logger.debug(`[DAEMON RUN] Cleaned up ${staleEntries.length} stale session(s) for resume ${options.resume}`);
          }
        }

        // Check if tmux is available and should be used
        const tmuxAvailable = options.consoleSession ? false : await isTmuxAvailable();
        let useTmux = tmuxAvailable;

        // Get tmux session name from environment variables (now set by profile system)
        // Empty string means "use current/most recent session" (tmux default behavior)
        let tmuxSessionName: string | undefined = extraEnv.TMUX_SESSION_NAME;

        // If tmux is not available or session name is explicitly undefined, fall back to regular spawning
        // Note: Empty string is valid (means use current/most recent tmux session)
        if (!tmuxAvailable || tmuxSessionName === undefined) {
          useTmux = false;
          if (tmuxSessionName !== undefined) {
            logger.debug(`[DAEMON RUN] tmux session name specified but tmux not available, falling back to regular spawning`);
          }
        }

        const childEnv = buildDaemonChildEnvironment(process.env, extraEnv, sessionAgent, options.resume);

        if (useTmux && tmuxSessionName !== undefined) {
          // Try to spawn in tmux session
          const sessionDesc = tmuxSessionName || 'current/most recent session';
          logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

          const tmux = getTmuxUtilities(tmuxSessionName);

          // Construct command for the CLI
          const cliPath = join(projectPath(), 'dist', 'index.mjs');
          // Determine agent command - support claude, codex, and gemini
          const fullCommand = `node --no-warnings --no-deprecation ${cliPath} ${buildDaemonSessionArgs(options, sessionAgent).join(' ')}`;

          // Spawn in tmux with the same environment used by regular spawning.
          const windowName = `happy-${Date.now()}-${sessionAgent}`;

          const tmuxResult = await tmux.spawnInTmux([fullCommand], {
            sessionName: tmuxSessionName,
            windowName: windowName,
            cwd: directory
          }, childEnv);

          if (tmuxResult.success) {
            logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }

            // Create a tracked session for tmux windows - now we have the real PID!
            const trackedSession: TrackedSession = {
              startedBy: 'daemon',
              pid: tmuxResult.pid, // Real PID from tmux -P flag
              tmuxSessionId: tmuxResult.sessionId,
              resumeTarget: options.resume,
              expectedHappySessionId: options.restoreSessionId,
              isConsoleSession: options.consoleSession,
              directoryCreated,
              message: directoryCreated
                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
                : `Spawned new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
            };

            // Add to tracking map so webhook can find it later
            pidToTrackedSession.set(tmuxResult.pid, trackedSession);

            // Wait for webhook to populate session with happySessionId (exact same as regular flow)
            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.pid} (tmux)`);

            return waitForTrackedSessionStartup({
              pid: tmuxResult.pid,
              suffix: ' (tmux)',
              timeoutMs: options.restoreSessionId
                ? RESTORE_SESSION_STARTUP_TIMEOUT_MS
                : NEW_SESSION_REGISTRATION_TIMEOUT_MS,
              register: awaiter => pidToAwaiter.set(tmuxResult.pid!, awaiter),
              unregister: () => pidToAwaiter.delete(tmuxResult.pid!),
              terminate: () => terminateTrackedSession(tmuxResult.pid!, trackedSession),
              complete: (completedSession) => {
                logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook (tmux)`);
                return { type: 'success', sessionId: completedSession.happySessionId! };
              },
            });
          } else {
            logger.debug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
            useTmux = false;
          }
        }

        // Regular process spawning (fallback or if tmux not available)
        if (!useTmux) {
          if (shuttingDown) {
            return { type: 'error', errorMessage: 'Daemon is shutting down' };
          }
          logger.debug(`[DAEMON RUN] Using regular process spawning`);

          const args = buildDaemonSessionArgs(options, sessionAgent);

          const happyProcess = spawnHappyCLI(args, {
            cwd: directory,
            detached: true,  // Sessions stay alive when daemon stops
            stdio: ['ignore', 'pipe', 'pipe'],  // Capture stdout/stderr for debugging
            env: childEnv
          });

          // Log output for debugging
          if (process.env.DEBUG) {
            happyProcess.stdout?.on('data', (data) => {
              logger.debug(`[DAEMON RUN] Child stdout: ${data.toString()}`);
            });
            happyProcess.stderr?.on('data', (data) => {
              logger.debug(`[DAEMON RUN] Child stderr: ${data.toString()}`);
            });
          }

          if (!happyProcess.pid) {
            logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
            return {
              type: 'error',
              errorMessage: 'Failed to spawn Happy process - no PID returned'
            };
          }

          logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);

          const trackedSession: TrackedSession = {
            startedBy: 'daemon',
            pid: happyProcess.pid,
            childProcess: happyProcess,
            resumeTarget: options.resume,
            expectedHappySessionId: options.restoreSessionId,
            isConsoleSession: options.consoleSession,
            directoryCreated,
            message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined
          };

          pidToTrackedSession.set(happyProcess.pid, trackedSession);

          happyProcess.on('exit', (code, signal) => {
            logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} exited with code ${code}, signal ${signal}`);
            if (happyProcess.pid) {
              onChildExited(happyProcess.pid);
            }
          });

          happyProcess.on('error', (error) => {
            logger.debug(`[DAEMON RUN] Child process error:`, error);
            if (happyProcess.pid) {
              onChildExited(happyProcess.pid);
            }
          });

          // Wait for webhook to populate session with happySessionId
          logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${happyProcess.pid}`);

          return waitForTrackedSessionStartup({
            pid: happyProcess.pid,
            timeoutMs: options.restoreSessionId
              ? RESTORE_SESSION_STARTUP_TIMEOUT_MS
              : NEW_SESSION_REGISTRATION_TIMEOUT_MS,
            register: awaiter => pidToAwaiter.set(happyProcess.pid!, awaiter),
            unregister: () => pidToAwaiter.delete(happyProcess.pid!),
            terminate: () => terminateTrackedSession(happyProcess.pid!, trackedSession),
            complete: (completedSession) => {
              logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
              return { type: 'success', sessionId: completedSession.happySessionId! };
            },
          });
        }

        // This should never be reached, but TypeScript requires a return statement
        return {
          type: 'error',
          errorMessage: 'Unexpected error in session spawning'
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
      }
    };

    // Force-close a session by Happy session id or exact tracked PID fallback.
    const stopSession = async (
      sessionId: string,
      recoveredEvidence?: ReadonlyArray<{ pid: number; sessionId: string }>,
    ): Promise<boolean> => {
      const initialMatches = matchingTrackedSessions(sessionId);
      const pidFallback = /^PID-([1-9][0-9]*)$/.test(sessionId);
      const happySessionId = pidFallback
        ? initialMatches[0]?.[1].happySessionId
        : sessionId;
      const lifecycleId = happySessionId ?? sessionId;
      return runSerial(lifecycleQueue, lifecycleId, async () => {
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

      const ownershipEvidence = recoveredEvidence
        ?? recoverRestoredDaemonSessions(await findAllHappyProcesses());
      if (initialMatches.some(([pid, tracked]) => pidToTrackedSession.get(pid) !== tracked
        || !isDaemonManagedSession(tracked, ownershipEvidence))) {
        logger.debug(`[DAEMON RUN] Refusing to stop an unowned session process for ${sessionId}`);
        return false;
      }

      if (happySessionId && !isSafeHappySessionId(happySessionId)) {
        logger.debug(`[DAEMON RUN] Refusing unsafe Happy session id: ${happySessionId}`);
        return false;
      }

      let ownsSession = initialMatches.length > 0;
      if (happySessionId) {
        closingSessionIds.add(happySessionId);
        try {
          const closeResult = await closeRestoreFile(happySessionId, initialMatches.length > 0);
          ownsSession = ownsSession || closeResult !== 'missing';
          if (!ownsSession) {
            closingSessionIds.delete(happySessionId);
            logger.debug(`[DAEMON RUN] Session ${happySessionId} is neither tracked nor locally restorable`);
            return false;
          }
          sendSessionEnd?.(happySessionId);
          // Reuse the daemon shutdown drain window so the machine Socket.IO
          // event reaches the server before any matching process is terminated.
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          closingSessionIds.delete(happySessionId);
          logger.debug(`[DAEMON RUN] Failed to close restore authority for ${happySessionId}:`, error);
          return false;
        }
      } else if (!ownsSession) {
        logger.debug(`[DAEMON RUN] PID fallback ${sessionId} is not tracked`);
        return false;
      }

      const terminateTarget = happySessionId || sessionId;
      const matches = matchingTrackedSessions(terminateTarget);
      const results = await Promise.all(matches.map(([pid, tracked]) =>
        terminateTrackedSession(pid, tracked)));
      const allExited = results.every(Boolean) && matchingTrackedSessions(terminateTarget).length === 0;
      if (!allExited) {
        if (happySessionId) closingSessionIds.delete(happySessionId);
        logger.debug(`[DAEMON RUN] Session ${terminateTarget} still has a matching tracked process`);
        return false;
      }

      if (happySessionId) closingSessionIds.delete(happySessionId);
      logger.debug(`[DAEMON RUN] Force-closed session ${terminateTarget}`);
      return true;
      });
    };

    // Handle child process exit
    const onChildExited = (pid: number) => {
      logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      const tracked = pidToTrackedSession.get(pid);
      const awaiter = pidToAwaiter.get(pid);
      if (awaiter) {
        pidToAwaiter.delete(pid);
        awaiter.fail('Happy child exited before provider restore was ready');
      }
      pidToTrackedSession.delete(pid);
      const sessionId = tracked?.happySessionId ?? tracked?.expectedHappySessionId;
      if (sessionId && closingSessionIds.has(sessionId)
        && existsSync(getClosedRestoreFilePath(sessionId))
        && matchingTrackedSessions(sessionId).length === 0) {
        closingSessionIds.delete(sessionId);
      }
    };

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getObservedChildren,
      stopSession,
      restoreSession: (sessionId, permissionMode) => restoreControlSession(sessionId, permissionMode),
      replaceSession: (input) => replaceControlSession(input),
      spawnSession,
      prepareShutdown: async ({ stopSessions }) => {
        if (shuttingDown) return { accepted: false as const, error: 'Daemon shutdown is already in progress' };
        if (daemonHandoffIsBusy(pidToAwaiter.size, lifecycleQueue.size, webhookQueue.size)) {
          return { accepted: false as const,
            error: 'Daemon shutdown deferred while session lifecycle work is in progress' };
        }
        const userChildren = getCurrentChildren().filter(child => child.isConsoleSession !== true);
        const recoveredEvidence = recoverRestoredDaemonSessions(await findAllHappyProcesses());
        if (!stopSessions && daemonHandoffHasUnrecoverableSessions(userChildren, recoveredEvidence)) {
          return { accepted: false as const,
            error: 'Daemon shutdown deferred because a daemon child lacks exact restore identity' };
        }
        if (shutdownHasUnownedTargets(stopSessions, userChildren, recoveredEvidence)) {
          return { accepted: false as const,
            error: 'A user session is not owned by the current daemon; no session was stopped' };
        }
        shuttingDown = true;
        if (!stopSessions) return { accepted: true as const };
        const results = await Promise.all(userChildren.map(async (child) => {
          const id = child.happySessionId?.trim() || `PID-${child.pid}`;
          try {
            return await stopSession(id, recoveredEvidence);
          } catch (error) {
            logger.debug(`[DAEMON RUN] Failed to stop ${id} during shutdown preflight`, error);
            return false;
          }
        }));
        if (results.every(Boolean)) return { accepted: true as const };
        shuttingDown = false;
        return { accepted: false as const, error: 'At least one user session could not be stopped safely' };
      },
      requestShutdown: () => requestShutdown('happy-cli'),
      onHappySessionWebhook,
      onSessionTurn,
      onCodexProfile: updateRestoreCodexProfile,
    });

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: logger.logFilePath
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create(credentials);

    // Get or create machine
    const machine = await api.getOrCreateMachine({
      machineId,
      metadata: initialMachineMetadata,
      daemonState: initialDaemonState
    });
    logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);
    sendSessionEnd = (sessionId: string) => apiMachine.sendSessionEnd(sessionId);

    type ExactRestoreResult = SpawnSessionResult & { agent?: RestoreFileData['agent'] };
    const restoreSessionUnlocked = async (params: { sessionId: string; claudeSessionId: string | null;
      summary: string | null; permissionMode?: PermissionMode }): Promise<ExactRestoreResult> => {
      if (shuttingDown) return { type: 'error', errorMessage: 'Daemon is shutting down' };
      if (!isSafeHappySessionId(params.sessionId)) return { type: 'error', errorMessage: 'Invalid Happy session ID' };
      if (closingSessionIds.has(params.sessionId)) {
        return { type: 'error', errorMessage: 'Session close is still in progress' };
      }

      const tracked = matchingTrackedSessions(params.sessionId).filter(([pid, session]) => {
        if (isProcessAlive(pid)) return true;
        if (pidToTrackedSession.get(pid) === session) pidToTrackedSession.delete(pid);
        return false;
      });
      if (tracked.length > 1) return { type: 'error', errorMessage: 'Multiple processes own the Happy session' };
      if (tracked.length === 1 && isExactOnlineConsoleOwner(tracked[0]![1], params.sessionId)) {
        return { type: 'success', sessionId: params.sessionId };
      }
      if (typeof params.claudeSessionId !== 'string' || !params.claudeSessionId) {
        return { type: 'error', errorMessage: 'Happy provider restore identity is unavailable' };
      }

      let opened: Awaited<ReturnType<typeof reopenRestoreFile>>;
      try { opened = await reopenRestoreFile(params.sessionId); }
      catch (error) { return { type: 'error', errorMessage: error instanceof Error ? error.message : String(error) }; }
      const rollbackReopen = async (): Promise<void> => {
        // A failed restore has no live owner, regardless of whether this call
        // reopened a closed authority or inherited one left open by an earlier
        // failed candidate. Close it so the next request starts from a truthful
        // state instead of an open file with no input consumer.
        try { await closeRestoreFile(params.sessionId, true); }
        catch (error) { logger.debug(`[DAEMON RUN] Failed to roll back restore authority for ${params.sessionId}:`, error); }
      };
      const failOpened = async (errorMessage: string): Promise<ExactRestoreResult> => {
        await rollbackReopen();
        return { type: 'error', errorMessage };
      };
      const restoreData = opened.data;
      const environmentVariables = buildRestoreProfileEnvironment(restoreData);
      if (environmentVariables && !existsSync(join(environmentVariables.CODEX_HOME, 'auth.json'))) {
        return failOpened(`Codex restore profile is unavailable: ${restoreData.codexProfile}`);
      }

      if (tracked.length === 1) {
        const [pid, current] = tracked[0]!;
        if (current.happySessionId !== params.sessionId
          || (current.expectedHappySessionId !== undefined
            && current.expectedHappySessionId !== params.sessionId)
          || (current.resumeTarget !== undefined && current.resumeTarget !== params.claudeSessionId)
          || (current.observedProviderSessionId !== undefined
            && current.observedProviderSessionId !== params.claudeSessionId)) {
          return failOpened('Tracked Happy restore identity does not match the requested session');
        }
        const state = classifyTrackedInputState(current);
        if (state === 'online') {
          if (current.observedProviderSessionId !== params.claudeSessionId) {
            return failOpened('Tracked Happy provider identity is not exact');
          }
          return { type: 'success', sessionId: params.sessionId, agent: restoreData.agent };
        }
        return failOpened('Happy session process is alive but has not registered an input-ready provider');
      }

      logger.debug(`[DAEMON RUN] Restoring session ${params.sessionId} in ${restoreData.directory}`);
      const result = await spawnSession({
        directory: restoreData.directory,
        agent: restoreData.agent,
        resume: params.claudeSessionId,
        title: params.summary || undefined,
        ...(restoreData.titleAuthority === 'external' ? { titleAuthority: 'external' as const } : {}),
        restoreSessionId: params.sessionId,
        permissionMode: params.permissionMode,
        environmentVariables,
      });
      if (result.type !== 'success') {
        await rollbackReopen();
        return result;
      }
      if (result.sessionId !== params.sessionId) {
        const terminatedRequested = await terminateSession(params.sessionId);
        const terminatedReported = terminatedRequested || await terminateSession(result.sessionId);
        await rollbackReopen();
        return { type: 'error', errorMessage: terminatedRequested || terminatedReported
          ? 'Restored session identity mismatch'
          : 'Restored session identity mismatch and termination failed' };
      }
      return { ...result, agent: restoreData.agent };
    };

    const restoreSession = (params: { sessionId: string; claudeSessionId: string | null;
      summary: string | null; permissionMode?: PermissionMode }): Promise<ExactRestoreResult> =>
      runSerial(lifecycleQueue, params.sessionId, () => restoreSessionUnlocked(params));

    restoreControlSession = (sessionId, permissionMode) => runSerial(lifecycleQueue, sessionId, async () => {
      let remote;
      try { remote = await api.restoreSessionById(sessionId); }
      catch (error) { return { type: 'error', errorMessage: error instanceof Error ? error.message : String(error) }; }
      const providerSessionId = remote.metadata?.claudeSessionId;
      const summaryValue = remote.metadata?.summary;
      const summary = summaryValue && typeof summaryValue === 'object'
        && typeof (summaryValue as { text?: unknown }).text === 'string'
        ? (summaryValue as { text: string }).text : null;
      return restoreSessionUnlocked({ sessionId,
        claudeSessionId: typeof providerSessionId === 'string' ? providerSessionId : null,
        summary, permissionMode });
    });

    replaceControlSession = (input) => runSerial(lifecycleQueue, input.previousSessionId, async () => {
      if (!isSafeHappySessionId(input.previousSessionId)
        || !CODEX_PROVIDER_SESSION_ID.test(input.providerSessionId)
        || !XC_VIRTUAL_SESSION_ID_PATTERN.test(input.virtualSessionId)) {
        return { type: 'error', errorMessage: 'Invalid closed-session replacement identity' };
      }
      if (matchingTrackedSessions(input.previousSessionId).some(([pid]) => isProcessAlive(pid))) {
        return { type: 'error', errorMessage: 'Happy session is still running' };
      }
      const restoreData = await readRestoreFile(input.previousSessionId);
      if (!restoreData) return { type: 'error', errorMessage: 'Closed-session restore authority is missing' };
      const result = await spawnSession({ directory: restoreData.directory, agent: restoreData.agent,
        resume: input.providerSessionId, title: input.title,
        ...(restoreData.titleAuthority === 'external' ? { titleAuthority: 'external' as const } : {}),
        environmentVariables: buildRestoreProfileEnvironment(restoreData),
        xcReplacement: { sessionId: input.virtualSessionId, previousOpener: input.previousSessionId,
          providerBinding: input.providerSessionId },
      });
      return result.type === 'success' ? { ...result, agent: restoreData.agent } : result;
    });

    const publishSessionError = async (params: {
      sessionId: string;
      eventId: string;
      source: string;
      code: string;
      message: string;
    }): Promise<boolean> => {
      if (!isSafeHappySessionId(params.sessionId) || !params.eventId || !params.source || !params.code || !params.message) {
        return false;
      }
      const session = await api.restoreSessionById(params.sessionId);
      const workspace = session.metadata?.path;
      const notice = typeof workspace === 'string' && workspace
        ? await reportProjectError({ workspace, source: params.source, code: params.code,
            message: params.message, reportedBy: params.sessionId })
        : null;
      await api.sessionMessageClient(session).sendAgentEventOnce({
        messageRole: 'agent',
        messageType: 'event',
        message: notice ?? params.message,
        eventId: params.eventId,
        localId: sessionErrorLocalId(params.sessionId, params.eventId),
        timeoutMs: 20_000,
      });
      return true;
    };

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      stopSession,
      rollbackRestoredSession: (sessionId) => runSerial(lifecycleQueue, sessionId,
        () => terminateSession(sessionId)),
      publishSessionError,
      requestShutdown: () => requestShutdown('happy-app'),
      restoreSession,
    });

    // Connect to server
    apiMachine.connect();

    // Spawn console session (lightweight bang-command-only session for mobile control)
    let consoleSessionSpawning = false;
    const consoleDir = join(configuration.happyHomeDir, 'console');
    try {
      await fs.mkdir(consoleDir, { recursive: true });
    } catch { /* already exists */ }

    const spawnConsoleSession = async () => {
      if (consoleSessionSpawning) return;
      consoleSessionSpawning = true;
      logger.debug('[DAEMON RUN] Spawning console session');
      try {
        const result = await spawnSession({
          directory: consoleDir,
          consoleSession: true,
          approvedNewDirectoryCreation: true,
        });
        if (result.type === 'success') {
          const tracked = selectTrackedConsoleSessions(pidToTrackedSession)
            .find(([, session]) => session.happySessionId === result.sessionId);
          logger.debug(`[DAEMON RUN] Console session spawned: ${result.sessionId} (PID: ${tracked?.[0] ?? 'unknown'})`);
        } else {
          logger.debug(`[DAEMON RUN] Failed to spawn console session: ${result.type === 'error' ? result.errorMessage : 'approval needed'}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to spawn console session:', error);
      } finally {
        consoleSessionSpawning = false;
      }
    };

    // Fire-and-forget — don't block other RPC handling
    spawnConsoleSession();

    // Every 60 seconds: prune stale sessions, preserve the console, and write
    // the heartbeat. Version replacement is intentionally an explicit command.
    const heartbeatIntervalMs = parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    const healthAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;
      try {

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      for (const [pid, _] of pidToTrackedSession.entries()) {
        try {
          // Check if process is still alive (signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
        } catch (error) {
          // Process is dead, remove from tracking
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          pidToTrackedSession.delete(pid);
        }
      }

      // Re-spawn console session if it died
      const consoleAlive = selectTrackedConsoleSessions(pidToTrackedSession)
        .some(([pid]) => isProcessAlive(pid));
      if (!consoleAlive && !consoleSessionSpawning) {
          logger.debug('[DAEMON RUN] Console session is absent, re-spawning');
          spawnConsoleSession();
      }

      // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.')
      }

      // Heartbeat
      try {
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          lastHeartbeat: new Date().toLocaleString(),
          daemonLogPath: fileState.daemonLogPath
        };
        writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }

      await pruneLogDirectory(configuration.logsDir, logger.logFilePath)
        .catch(error => logger.debug('[DAEMON RUN] Failed to prune logs', error));

      } finally {
        heartbeatRunning = false;
      }
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      // Cancel the startup watchdog now that graceful cleanup is actually running.
      // It was only a fallback for the "signal arrives before startup completes" case.
      if (startupMalfunctionTimer) {
        clearTimeout(startupMalfunctionTimer);
        startupMalfunctionTimer = null;
        logger.debug('[DAEMON RUN] Shutdown watchdog cleared (graceful path engaged)');
      }

      // Flip the shutdown flag so restoreSession RPC from server rejects new
      // work instead of racing to spawn children inside the shutdown window.
      shuttingDown = true;

      if (healthAndHeartbeat) {
        clearInterval(healthAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      // prepareShutdown has already handled user sessions. The console session
      // is daemon-internal and remains the only process cleanup owns here.
      const consoleSessions = selectTrackedConsoleSessions(pidToTrackedSession);
      if (consoleSessions.length > 0) {
        for (const [, consoleTracked] of consoleSessions) {
          if (consoleTracked.happySessionId) {
            logger.debug(`[DAEMON RUN] Sending session-end for console session ${consoleTracked.happySessionId}`);
            apiMachine.sendSessionEnd(consoleTracked.happySessionId);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        const results = await Promise.all(consoleSessions.map(([pid, tracked]) =>
          terminateTrackedSession(pid, tracked).catch(error => {
            logger.debug(`[DAEMON RUN] Failed to terminate console PID ${pid}:`, error);
            return false;
          })));
        if (results.some((terminated, index) => !terminated
          && isProcessAlive(consoleSessions[index][0]))) {
          throw new Error('Daemon shutdown left a console process alive');
        }
      }

      // Remote status is observational. Never let a missing ACK block local
      // shutdown or the replacement daemon's lock acquisition.
      void apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      })).catch(error => logger.debug('[DAEMON RUN] Failed to publish shutdown state', error));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
