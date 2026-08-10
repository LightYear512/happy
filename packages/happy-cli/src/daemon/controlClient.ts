/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState } from '@/persistence';
import type { Metadata, PermissionMode } from '@/api/types';
import { configuration } from '@/configuration';

type DaemonPostError = { error: string; status?: number };

async function daemonPost(path: string, body?: any): Promise<DaemonPostError | any> {
  const state = await readDaemonState();
  if (!state?.httpPort) {
    const errorMessage = 'No daemon running, no state file found';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    process.kill(state.pid, 0);
  } catch (error) {
    const errorMessage = 'Daemon is not running, file is stale';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    const timeout = process.env.HAPPY_DAEMON_HTTP_TIMEOUT ? parseInt(process.env.HAPPY_DAEMON_HTTP_TIMEOUT) : 10_000;
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      // Mostly increased for stress test
      signal: AbortSignal.timeout(timeout)
    });
    
    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return {
        error: errorMessage,
        status: response.status,
      };
    }
    
    return await response.json();
  } catch (error) {
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    }
  }
}

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata,
  readyProviderSessionId?: string,
): Promise<{ error?: string } | any> {
  return await daemonPost('/session-started', {
    sessionId,
    metadata,
    ...(readyProviderSessionId ? { readyProviderSessionId } : {}),
  });
}

export async function notifyDaemonCodexProfile(
  sessionId: string,
  profileName: string,
  options: { maxAttempts?: number; retryDelayMs?: number } = {},
): Promise<{ error?: string } | any> {
  const maxAttempts = options.maxAttempts ?? 8;
  const retryDelayMs = options.retryDelayMs ?? 25;
  let result: DaemonPostError | any;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = await daemonPost('/session-codex-profile', { sessionId, profileName });
    if (!result.error || result.status !== 409 || attempt === maxAttempts) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
  }

  return result;
}

export async function listDaemonSessions(): Promise<any[]> {
  const result = await daemonPost('/list');
  if (result.error) throw new Error(result.error);
  return result.children || [];
}

export async function stopDaemonSession(sessionId: string): Promise<boolean> {
  const result = await daemonPost('/stop-session', { sessionId });
  return result.success || false;
}

export async function restoreDaemonSession(
  sessionId: string,
  permissionMode?: PermissionMode,
): Promise<any> {
  return await daemonPost('/restore-session', { sessionId, permissionMode });
}

export async function spawnDaemonSession(
  directory: string,
  restoreSessionId?: string,
  resume?: string,
  title?: string,
  agent?: 'claude' | 'codex' | 'gemini'
): Promise<any> {
  const result = await daemonPost('/spawn-session', {
    directory,
    sessionId: restoreSessionId,
    resume,
    title,
    agent,
  });
  return result;
}

export async function stopDaemonHttp(options?: { stopSessions?: boolean }): Promise<'stopping' | 'blocked'> {
  const result = await daemonPost('/stop', options?.stopSessions ? { stopSessions: true } : undefined);
  if (result.error) throw new Error(result.error);
  if (result.status !== 'stopping' && result.status !== 'blocked') {
    throw new Error('Daemon returned an invalid shutdown result');
  }
  return result.status;
}

/** Check whether daemon state currently points at a live process. */
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const state = await readDaemonState();
  if (!state) {
    return false;
  }

  // Check if the daemon is running
  try {
    process.kill(state.pid, 0);
    return true;
  } catch {
    logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up state');
    await cleanupDaemonState();
    return false;
  }
}

/**
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 * 
 * @returns true if versions match, false if versions differ or no daemon running
 */
export async function isDaemonRunningCurrentlyInstalledHappyVersion(): Promise<boolean> {
  logger.debug('[DAEMON CONTROL] Checking if daemon is running same version');
  const runningDaemon = await checkIfDaemonRunningAndCleanupStaleState();
  if (!runningDaemon) {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
  }

  const state = await readDaemonState();
  if (!state) {
    logger.debug('[DAEMON CONTROL] No daemon state found, returning false');
    return false;
  }
  
  logger.debug(`[DAEMON CONTROL] Current process CLI version: ${configuration.currentCliVersion}, Daemon started with version: ${state.startedWithCliVersion}`);
  return daemonVersionMatchesCurrentProcess(state.startedWithCliVersion);
}

export function daemonVersionMatchesCurrentProcess(startedWithCliVersion: string): boolean {
  return configuration.currentCliVersion === startedWithCliVersion;
}

export function shouldSessionEnsureDaemon(startedBy: 'daemon' | 'terminal' | undefined): boolean {
  return startedBy !== 'daemon';
}

export async function cleanupDaemonState(): Promise<void> {
  try {
    await clearDaemonState();
    logger.debug('[DAEMON RUN] Daemon state file removed');
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

export async function stopDaemon(options?: { stopSessions?: boolean }): Promise<boolean> {
  try {
    const state = await readDaemonState();
    if (!state) {
      logger.debug('No daemon state found');
      return true;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`, { stopSessions: options?.stopSessions });

    // Try HTTP graceful stop
    try {
      const status = await stopDaemonHttp(options);
      if (status === 'blocked') {
        logger.debug('Daemon refused an unsafe shutdown request');
        return false;
      }

      // Wait for daemon to die (allow more time when stopping sessions)
      await waitForProcessDeath(state.pid, options?.stopSessions ? 10000 : 2000);
      logger.debug('Daemon stopped gracefully via HTTP');
      return true;
    } catch (error) {
      try {
        process.kill(state.pid, 0);
      } catch {
        logger.debug('Daemon was already dead; stale state can be reclaimed by startup');
        return true;
      }
      logger.debug('Refusing to kill a live daemon after graceful shutdown failed', error);
      return false;
    }
  } catch (error) {
    logger.debug('Error stopping daemon', error);
    return false;
  }
}

async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      return; // Process is dead
    }
  }
  throw new Error('Process did not die within timeout');
}
