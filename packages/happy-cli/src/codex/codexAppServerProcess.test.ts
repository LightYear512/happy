/** Exercise real OS teardown, including a grandchild that outlives the CLI shim. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexProcessCleanupError, stopCodexProcess } from './codexAppServerProcess';
import { CodexAppServerRequestTimeout } from './codexAppServerClient';

describe('Codex cleanup failure diagnostics', () => {
    it('keeps cleanup fatal and exposes the original operation to message-only consumers', () => {
        const operation = new CodexAppServerRequestTimeout('thread/resume', 30_000);
        const cleanup = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
        const failure = new CodexProcessCleanupError(new CodexProcessCleanupError(cleanup), operation);
        expect(failure).toBeInstanceOf(CodexProcessCleanupError);
        expect(failure).not.toBeInstanceOf(CodexAppServerRequestTimeout);
        expect(failure.cause).toBe(cleanup);
        expect(failure.operationError).toBe(operation);
        expect(failure.message).toContain('thread/resume timed out after 30000ms');
        expect(failure.message).toContain('kill EPERM');
        const propagated = new CodexProcessCleanupError(failure);
        expect(propagated.message).toBe(failure.message);
        expect(propagated.cause).toBe(cleanup);
        expect(propagated.operationError).toBe(operation);
    });

    it('retains both signal and process-table failures through the cleanup cause', () => {
        const signal = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
        const probe = new Error('ps timed out');
        const failure = new CodexProcessCleanupError(new AggregateError([signal, probe],
            'Signal EPERM and ps timeout'), new Error('initialize rejected'));
        expect((failure.cause as AggregateError).errors).toEqual([signal, probe]);
        expect(failure.message).toContain('Signal EPERM and ps timeout');
        expect(failure.message).toContain('initialize rejected');
    });

    it('bounds and redacts displayed details while preserving the original errors', () => {
        const cleanup = new Error(`password=cleanup-secret ${'x'.repeat(4_000)}`);
        const operation = new Error(`initialize token=operation-secret ${'y'.repeat(4_000)}`);
        const failure = new CodexProcessCleanupError(cleanup, operation);
        expect(failure.message).not.toContain('cleanup-secret');
        expect(failure.message).not.toContain('operation-secret');
        expect(failure.message).toContain('Original operation failed: Error: initialize');
        expect(failure.message.length).toBeLessThan(2_200);
        expect(failure.cause).toBe(cleanup);
        expect(failure.operationError).toBe(operation);
    });
});

describe.skipIf(process.platform === 'win32')('owned Codex process groups', () => {
    const owned: Array<{ child: ChildProcess; closed: Promise<void> }> = [];
    const launch = (script: string): typeof owned[number] => {
        const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const entry = { child, closed: once(child, 'close').then(() => undefined) };
        owned.push(entry);
        return entry;
    };
    afterEach(async () => {
        await Promise.all(owned.splice(0).map(({ child, closed }) => stopCodexProcess(child, closed, 50, 1_000)));
    });
    it('kills a TERM-resistant grandchild after its parent exits without touching another group', async () => {
        const other = launch('setInterval(() => {}, 1000); console.log("ready")');
        await once(other.child.stdout!, 'data');
        const entry = launch(`
            const { spawn } = require('node:child_process');
            const child = spawn(process.execPath, ['-e',
                'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready")'],
                { stdio: ['ignore', 'pipe', 'inherit'] });
            child.stdout.once('data', () => { console.log(child.pid); process.exit(0); });
        `);
        const [chunk] = await once(entry.child.stdout!, 'data');
        const grandchildPid = Number(String(chunk).trim());
        expect(grandchildPid).toBeGreaterThan(1);
        await stopCodexProcess(entry.child, entry.closed, 50, 1_000);
        const processes = execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
            .trim().split('\n').map(row => row.trim().split(/\s+/u).map(Number));
        expect(processes.length).toBeGreaterThan(0);
        expect(processes.every(row => row.length === 2
            && row.every(id => Number.isSafeInteger(id) && id > 0))).toBe(true);
        expect(processes.some(([pid, group]) => pid === grandchildPid || group === entry.child.pid)).toBe(false);
        expect(() => process.kill(other.child.pid!, 0)).not.toThrow();
    }, 10_000);
});
