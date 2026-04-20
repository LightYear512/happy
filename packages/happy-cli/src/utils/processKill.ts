import { spawn } from 'child_process';
import { logger } from '@/ui/logger';

/**
 * Kill a process and all its descendants (process tree) cross-platform.
 *
 * IMPORTANT — this is ASYNC by design. A previous `spawnSync` implementation
 * blocked the event loop for 2-3s per call on Windows, which starved
 * Socket.IO's send buffer and caused `session-end` events to be lost during
 * daemon shutdown. Always `await` this function from cleanup paths so the
 * event loop keeps running.
 *
 * Windows: `taskkill /F /T /PID` — the `/T` flag walks the process tree. Node's
 * `process.kill(pid, 'SIGTERM')` maps to `TerminateProcess` which does NOT
 * cascade, so we must shell out.
 *
 * Unix: try `process.kill(-pid, 'SIGTERM')` first, signalling the entire
 * process group (requires `detached: true` at spawn time). Fall back to a
 * direct `process.kill(pid, 'SIGTERM')` if the pgroup send fails. Registered
 * SIGTERM handlers still run so children can do graceful cleanup before exit.
 */
export function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const child = spawn('taskkill', ['/F', '/T', '/PID', pid.toString()], {
          stdio: 'ignore',
          windowsHide: true,
        });
        child.once('exit', (code) => {
          if (code !== 0 && code !== null) {
            logger.debug(`[killProcessTree] taskkill /T /PID ${pid} exit code ${code}`);
          }
          done();
        });
        child.once('error', (error) => {
          logger.debug(`[killProcessTree] taskkill /T /PID ${pid} error:`, error);
          done();
        });
      } catch (error) {
        logger.debug(`[killProcessTree] spawn taskkill failed for ${pid}:`, error);
        done();
      }
    });
  }
  try {
    process.kill(-pid, 'SIGTERM');
    return Promise.resolve();
  } catch (error) {
    logger.debug(`[killProcessTree] pgroup kill for -${pid} failed, falling back to direct pid:`, error);
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    logger.debug(`[killProcessTree] process.kill(${pid}, SIGTERM) failed:`, error);
  }
  return Promise.resolve();
}
