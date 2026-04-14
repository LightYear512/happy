import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { mockSpawn } = vi.hoisted(() => ({
    mockSpawn: vi.fn(),
}));

vi.mock('child_process', () => ({
    spawn: mockSpawn,
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { killProcessTree } from './processKill';

/**
 * Fake ChildProcess that we can drive via manual `exit`/`error` emits from the
 * test body. Enough of an EventEmitter to satisfy the `child.once(...)` calls
 * inside killProcessTree's Windows branch.
 */
function makeFakeChild(): EventEmitter & { settle: (code: number | null, err?: Error) => void } {
    const ee = new EventEmitter() as any;
    ee.settle = (code: number | null, err?: Error) => {
        if (err) {
            ee.emit('error', err);
        } else {
            ee.emit('exit', code);
        }
    };
    return ee;
}

const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

describe('killProcessTree — async contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns a Promise (not void) — required to keep event loop unblocked in shutdown path', () => {
        setPlatform('win32');
        mockSpawn.mockImplementation(() => {
            const child = makeFakeChild();
            setImmediate(() => child.settle(0));
            return child as any;
        });
        const result = killProcessTree(123);
        expect(result).toBeInstanceOf(Promise);
    });
});

describe('killProcessTree — Windows branch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setPlatform('win32');
    });

    it('invokes taskkill with /F /T /PID and the target pid', async () => {
        mockSpawn.mockImplementation(() => {
            const child = makeFakeChild();
            setImmediate(() => child.settle(0));
            return child as any;
        });

        await killProcessTree(42);

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const [cmd, args, opts] = mockSpawn.mock.calls[0];
        expect(cmd).toBe('taskkill');
        expect(args).toEqual(['/F', '/T', '/PID', '42']);
        expect(opts).toMatchObject({ stdio: 'ignore', windowsHide: true });
    });

    it('resolves even when taskkill exits with non-zero code (does not throw)', async () => {
        mockSpawn.mockImplementation(() => {
            const child = makeFakeChild();
            setImmediate(() => child.settle(128));
            return child as any;
        });

        await expect(killProcessTree(99)).resolves.toBeUndefined();
    });

    it('resolves when taskkill errors during spawn (does not throw)', async () => {
        mockSpawn.mockImplementation(() => {
            const child = makeFakeChild();
            setImmediate(() => child.settle(null, new Error('ENOENT')));
            return child as any;
        });

        await expect(killProcessTree(99)).resolves.toBeUndefined();
    });

    it('resolves when spawn itself throws (does not break cleanup loop)', async () => {
        mockSpawn.mockImplementation(() => {
            throw new Error('spawn failed synchronously');
        });

        await expect(killProcessTree(99)).resolves.toBeUndefined();
    });

    it('resolves only once even if both exit and error fire', async () => {
        mockSpawn.mockImplementation(() => {
            const child = makeFakeChild();
            setImmediate(() => {
                child.settle(0);
                child.emit('error', new Error('after-exit error'));
            });
            return child as any;
        });

        await expect(killProcessTree(1)).resolves.toBeUndefined();
    });
});

describe('killProcessTree — Unix branch', () => {
    const originalKill = process.kill;

    beforeEach(() => {
        vi.clearAllMocks();
        setPlatform('linux');
    });

    afterEach(() => {
        process.kill = originalKill;
    });

    it('tries process group kill first: process.kill(-pid, SIGTERM)', async () => {
        const killMock = vi.fn();
        process.kill = killMock as any;

        await killProcessTree(1234);

        expect(killMock).toHaveBeenCalledTimes(1);
        expect(killMock).toHaveBeenCalledWith(-1234, 'SIGTERM');
    });

    it('falls back to direct-pid kill when pgroup kill throws ESRCH', async () => {
        const calls: Array<[number, string]> = [];
        process.kill = ((pid: number, sig: string) => {
            calls.push([pid, sig]);
            if (pid === -555) {
                const err = new Error('ESRCH') as any;
                err.code = 'ESRCH';
                throw err;
            }
        }) as any;

        await killProcessTree(555);

        // First call: process group attempt
        expect(calls[0]).toEqual([-555, 'SIGTERM']);
        // Second call: direct pid fallback
        expect(calls[1]).toEqual([555, 'SIGTERM']);
    });

    it('does NOT spawn anything on Unix (taskkill is Windows-only)', async () => {
        process.kill = vi.fn() as any;
        await killProcessTree(1);
        expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('resolves even when both pgroup and direct-pid kill fail (process already dead)', async () => {
        process.kill = (() => {
            const err = new Error('ESRCH') as any;
            err.code = 'ESRCH';
            throw err;
        }) as any;

        await expect(killProcessTree(1)).resolves.toBeUndefined();
    });
});
