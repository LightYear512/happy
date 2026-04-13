import { spawnSync } from 'child_process';
import { logger } from '@/ui/logger';

/**
 * Kill a process and all its descendants (process tree) cross-platform.
 *
 * Windows: `taskkill /F /T /PID` — the `/T` flag walks the process tree. Node's
 * `process.kill(pid, 'SIGTERM')` maps to `TerminateProcess` which does NOT
 * cascade, so we must shell out.
 *
 * Unix: try `process.kill(-pid, 'SIGTERM')` first, which signals the entire
 * process group (requires `detached: true` at spawn time so a new pgroup was
 * created). Fall back to `process.kill(pid, 'SIGTERM')` if the pgroup send
 * fails (e.g. the target wasn't detached, so pgid != pid). In both cases the
 * signal is SIGTERM — registered handlers still run and can do graceful
 * cleanup before exit.
 */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/F', '/T', '/PID', pid.toString()], { stdio: 'pipe' });
    if (result.error) {
      logger.debug(`[killProcessTree] taskkill /T /PID ${pid} failed:`, result.error);
      return;
    }
    if (result.status !== 0) {
      logger.debug(`[killProcessTree] taskkill /T /PID ${pid} exited code ${result.status}: ${result.stderr?.toString() ?? ''}`);
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
    return;
  } catch (error) {
    logger.debug(`[killProcessTree] pgroup kill for -${pid} failed, falling back to direct pid:`, error);
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    logger.debug(`[killProcessTree] process.kill(${pid}, SIGTERM) failed:`, error);
  }
}
