import { lstat, mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const DISPOSABLE_ROOT = process.platform === 'darwin'
    ? '/private/tmp/xc-disposable'
    : join(tmpdir(), 'xc-disposable');
const RESOLVED_DISPOSABLE_ROOT = resolve(DISPOSABLE_ROOT);

async function ensureDisposableRoot(): Promise<void> {
    await mkdir(DISPOSABLE_ROOT, { recursive: true, mode: 0o700 });
    const info = await lstat(DISPOSABLE_ROOT);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Disposable root is not a real directory: ${DISPOSABLE_ROOT}`);
    }
}

function validPrefix(prefix: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(prefix)) {
        throw new Error(`Invalid disposable directory prefix: ${prefix}`);
    }
    return prefix;
}

function assertDirectChild(directory: string): string {
    const resolved = resolve(directory);
    if (dirname(resolved) !== RESOLVED_DISPOSABLE_ROOT) {
        throw new Error(`Disposable directory is not a direct child: ${directory}`);
    }
    return resolved;
}

/** Creates one uniquely-owned direct child of the host disposable root. */
export async function createDisposableTempDirectory(prefix: string): Promise<string> {
    await ensureDisposableRoot();
    return mkdtemp(join(DISPOSABLE_ROOT, `${validPrefix(prefix)}.`));
}

/** Refreshes the owned direct child so long-running work is not reclaimed. */
export async function touchDisposableTempDirectory(directory: string): Promise<void> {
    const now = new Date();
    await utimes(assertDirectChild(directory), now, now);
}

/** Removes only the uniquely-owned direct child returned by this module. */
export async function removeDisposableTempDirectory(directory: string): Promise<void> {
    await rm(assertDirectChild(directory), { recursive: true, force: true });
}

export function disposableTempRoot(): string {
    return DISPOSABLE_ROOT;
}
