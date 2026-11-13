/** Actual detached-spawn authority and inherited-pipe retirement, without mocks. */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { captureSessionStartupDiagnostics, terminateTrackedSession, waitForTrackedSessionStartup } from './run';
import type { TrackedSession } from './types';
import { killOwnedProcessGroup, killProcessTree, spawnWithOwnedProcessGroup } from '@/utils/processKill';

describe.skipIf(process.platform === 'win32')('startup process-group ownership — real processes', () => {
    it('cleans an exited parent’s inherited-pipe group at the original deadline and preserves a peer', async () => {
        const peer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); console.log("ready")'], {
            detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const peerClosed = once(peer, 'close');
        const child = spawnWithOwnedProcessGroup(process.execPath, ['-e', String.raw`
            const { spawn } = require('node:child_process');
            const descendant = spawn(process.execPath, ['-e',
                "process.on('SIGTERM', () => { process.stderr.write('Error: provider retired\\n'); process.exitCode = 0; clearInterval(timer); }); const timer = setInterval(() => {}, 1000); console.log(process.pid)"
            ], { stdio: ['ignore', 'pipe', 'inherit'] });
            descendant.stdout.once('data', data => {
                process.stdout.write(data);
                descendant.stdout.destroy();
                descendant.unref();
                process.exitCode = 7;
            });
        `], { stdio: ['ignore', 'pipe', 'pipe'] });
        const diagnostics = captureSessionStartupDiagnostics(child);
        const exited = once(child, 'exit');
        let output = '';
        child.stdout!.on('data', data => { output += String(data); });
        try {
            await Promise.all([once(peer.stdout!, 'data'), exited]);
            const descendantPid = Number(output.trim());
            expect(descendantPid).toBeGreaterThan(1);
            expect(Number(execFileSync('ps', ['-p', String(descendantPid), '-o', 'pgid='], {
                encoding: 'utf8', timeout: 1000,
            }).trim())).toBe(child.pid);
            const record: TrackedSession = { startedBy: 'daemon', pid: child.pid!, childProcess: child };
            const tracked = new Map([[record.pid, record]]);
            expect(await terminateTrackedSession(record.pid, { ...record }, tracked)).toBe(false);
            // A different child handle with the same PID cannot manufacture spawn authority.
            const forged: TrackedSession = { ...record, childProcess: {
                pid: record.pid, exitCode: 7, signalCode: null,
            } as ChildProcess };
            tracked.set(record.pid, forged);
            expect(await terminateTrackedSession(record.pid, forged, tracked)).toBe(false);
            tracked.set(record.pid, record);
            const result = await waitForTrackedSessionStartup({
                pid: record.pid, deadlineAt: Date.now() + 20, timeoutMs: 58_000,
                register: () => {}, unregister: diagnostics.clear,
                describeFailure: diagnostics.describeFailure,
                terminate: () => terminateTrackedSession(record.pid, record, tracked),
                complete: () => { throw new Error('No provider readiness was emitted'); },
            });
            await diagnostics.closed;
            expect(result.type).toBe('error');
            if (result.type === 'error') {
                expect(result.errorMessage).toContain('Session startup timeout');
                expect(result.errorMessage).toContain('exitCode=7');
                expect(result.errorMessage).toContain('Error: provider retired');
                expect(result.errorMessage).not.toContain('process cleanup failed');
            }
            expect(() => process.kill(descendantPid, 0)).toThrow();
            expect(() => process.kill(-record.pid, 0)).toThrow();
            expect(tracked.size).toBe(0);
            expect(await killOwnedProcessGroup(child)).toBe(false);
            expect(() => process.kill(peer.pid!, 0)).not.toThrow();
        } finally {
            // Only handles/groups created by this test may be retired.
            await killOwnedProcessGroup(child);
            await diagnostics.closed;
            await killProcessTree(peer.pid!);
            await peerClosed;
        }
    }, 10_000);

    it('revokes group authority after close and does not adopt an ordinary spawn', async () => {
        const child = spawnWithOwnedProcessGroup(process.execPath, ['-e', 'process.exitCode = 7'], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        await once(child, 'close');
        expect(await killOwnedProcessGroup(child)).toBe(false);
        const ordinary = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); console.log("ready")'], {
            detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const closed = once(ordinary, 'close');
        try {
            await once(ordinary.stdout!, 'data');
            expect(await killOwnedProcessGroup(ordinary)).toBe(false);
            expect(() => process.kill(ordinary.pid!, 0)).not.toThrow();
        } finally {
            await killProcessTree(ordinary.pid!);
            await closed;
        }
    });
});
