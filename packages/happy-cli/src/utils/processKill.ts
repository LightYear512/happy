import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import psList from 'ps-list';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Ephemeral spawn authority, never serialized or reconstructed from a PID.
// Detached POSIX children create their own process group. Keep that original
// group until close (not exit): descendants may still hold the inherited pipes.
const detachedGroups = new WeakMap<ChildProcess, number>();

export function spawnWithOwnedProcessGroup(
  command: string, args: string[], options: SpawnOptions,
): ChildProcess {
  const child = spawn(command, args, { ...options, detached: true });
  if (process.platform !== 'win32' && child.pid !== undefined) {
    detachedGroups.set(child, child.pid);
    child.once('close', () => detachedGroups.delete(child));
  }
  return child;
}

/** Retire only the original group, never a dead leader's possibly reused PID. */
export async function killOwnedProcessGroup(child: ChildProcess): Promise<boolean> {
  const pid = detachedGroups.get(child);
  if (pid === undefined || pid !== child.pid) return false;
  await killProcessTargets([-pid]);
  detachedGroups.delete(child);
  return true;
}

/** Signal an already-owned PID/group; absence requires positive OS evidence. */
export async function signalOwnedProcess(target: number, value: NodeJS.Signals | 0): Promise<boolean> {
  try { process.kill(target, value); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    let probe = '';
    let cause: unknown = error;
    if (code === 'EPERM' && target < -1 && process.platform !== 'win32') {
      // Darwin may retain an empty group while a tty still references it.
      // kill(0) then reports EPERM, not ESRCH. Only an absent group in the
      // actual process table proves retirement; a visible group still fails.
      try {
        const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pgid='], { timeout: 1_000 });
        const groups = stdout.trim().split(/\s+/u).map(Number);
        if (groups.length > 0 && groups.every(group => Number.isSafeInteger(group) && group > 0)
          && !groups.includes(-target)) return false;
        probe = `; ps group probe: ${groups.includes(-target) ? 'target present' : 'invalid group list'}`;
      } catch (probeError) {
        probe = `; ps group probe failed: ${String(probeError).slice(0, 256)}`;
        cause = new AggregateError([error, probeError], 'Signal permission and process-group probe failed');
      }
    }
    throw new Error(`Process-tree signal ${value} to ${target} failed: ${String(error)}${probe}`, { cause });
  }
}

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
 * Unix: snapshot descendants before signaling, including detached sidecar
 * groups. Confirm teardown instead of equating a signal with successful exit.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error('Refusing to terminate an invalid process tree owner');
  }
  if (process.platform === 'win32') {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    return new Promise<void>((resolve, reject) => {
      execFile('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true, timeout: 2_000,
      }, (error) => error ? reject(error) : resolve());
    });
  }
  // Capture before an exiting CLI shim reparents (and hides) its descendants.
  const children = new Map<number, number[]>();
  for (const process of await psList()) {
    const siblings = children.get(process.ppid) ?? [];
    siblings.push(process.pid);
    children.set(process.ppid, siblings);
  }
  const owned = new Set([pid]);
  for (const parent of owned) for (const child of children.get(parent) ?? []) owned.add(child);
  const targets = [...owned].reverse().flatMap((child) => [-child, child]);
  await killProcessTargets(targets);
}

async function killProcessTargets(targets: number[]): Promise<void> {
  const anyAlive = async (): Promise<boolean> => {
    for (const target of targets) if (await signalOwnedProcess(target, 0)) return true;
    return false;
  };
  for (const [value, waitMs] of [['SIGTERM', 1_500], ['SIGKILL', 500]] as const) {
    for (const target of targets) await signalOwnedProcess(target, value);
    const deadline = Date.now() + waitMs;
    while (await anyAlive() && Date.now() < deadline) await delay(20);
    if (!await anyAlive()) return;
  }
  throw new Error(`Process targets ${targets.join(', ')} did not exit`);
}
