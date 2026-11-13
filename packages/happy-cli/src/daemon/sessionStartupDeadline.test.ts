/** The real timer shares the parent's absolute deadline; no fake clock. */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { captureSessionStartupDiagnostics, requireSessionStartupBudget, runSerial,
    waitForTrackedSessionStartup } from './run';

describe('startup diagnostics — actual child stderr', () => {
    it('retains the error without DEBUG and redacts secrets split across writes', async () => {
        const child = spawn(process.execPath, ['-e', `
            process.stderr.write('Error: startup failed\\nAuthorization: Bea');
            setTimeout(() => {
                process.stderr.write('rer sensitive-test-credential\\npassword=private-test-value\\n');
                process.stderr.write('sk-' + 'a'.repeat(32) + '\\n');
                process.exitCode = 7;
            }, 20);
        `], { stdio: ['ignore', 'ignore', 'pipe'] });
        const diagnostics = captureSessionStartupDiagnostics(child);
        await diagnostics.closed;
        const message = diagnostics.describeFailure('Startup failed');
        expect(message).toContain('exitCode=7, signal=none');
        expect(message).toContain('Error: startup failed');
        expect(message).toContain('[REDACTED]');
        expect(message).not.toContain('sensitive-test-credential');
        expect(message).not.toContain('private-test-value');
        expect(message).not.toContain('sk-' + 'a'.repeat(32));
    });

    it('bounds stderr and drops the incomplete final line before redaction', async () => {
        const child = spawn(process.execPath, ['-e', `
            process.stderr.write('Error: restore failed\\n' + 'password=' + 'x'.repeat(100000));
            process.exitCode = 1;
        `], { stdio: ['ignore', 'ignore', 'pipe'] });
        const diagnostics = captureSessionStartupDiagnostics(child);
        await diagnostics.closed;
        const message = diagnostics.describeFailure('Startup failed');
        expect(message).toContain('Error: restore failed');
        expect(message).toContain('[stderr truncated]');
        expect(message).not.toContain('xxxx');
        expect(Buffer.byteLength(message)).toBeLessThan(8 * 1024 + 200);
    });

    it('redacts JSON Authorization in actual startup stderr', async () => {
        const child = spawn(process.execPath, ['-e', String.raw`
            process.stderr.write(JSON.stringify({ headers: { Authorization: 'Bearer review-only-secret' } }));
            process.exitCode = 1;
        `], { stdio: ['ignore', 'ignore', 'pipe'] });
        const diagnostics = captureSessionStartupDiagnostics(child);
        await diagnostics.closed;
        const message = diagnostics.describeFailure('Startup failed');
        expect(message).toContain('exitCode=1');
        expect(message).toContain('[REDACTED]');
        expect(message).not.toContain('review-only-secret');
    });

    it('discards startup data and ignores later output after readiness', async () => {
        const child = spawn(process.execPath, ['-e', `
            process.stderr.write('startup diagnostic');
            setTimeout(() => process.stderr.write('later session content'), 20);
        `], { stdio: ['ignore', 'ignore', 'pipe'] });
        const diagnostics = captureSessionStartupDiagnostics(child);
        await once(child.stderr!, 'data');
        diagnostics.clear();
        await diagnostics.closed;
        const message = diagnostics.describeFailure('Startup failed');
        expect(message).toContain('exitCode=0, signal=none');
        expect(message).not.toContain('startup diagnostic');
        expect(message).not.toContain('later session content');
    });

    it.skipIf(process.platform === 'win32')('reports signal termination', async () => {
        const child = spawn(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        const diagnostics = captureSessionStartupDiagnostics(child);
        await diagnostics.closed;
        expect(diagnostics.describeFailure('Startup failed')).toContain('exitCode=null, signal=SIGTERM');
    });

    it('redacts complete punctuation-bearing passwords and refresh tokens', async () => {
        const child = spawn(process.execPath, ['-e', String.raw`
            process.stderr.write('password=P@ssw0rd!\nrefresh_token=review-only-credential-value\n');
            process.exitCode = 7;
        `], { stdio: ['ignore', 'ignore', 'pipe'] });
        const diagnostics = captureSessionStartupDiagnostics(child);
        await diagnostics.closed;
        const message = diagnostics.describeFailure('Startup failed');
        expect(message).not.toContain('P@ssw0rd!');
        expect(message).not.toContain('review-only-credential-value');
        expect(message).toContain('password=[REDACTED]');
        expect(message).toContain('refresh_token=[REDACTED]');
    });

    it('retains inherited stderr arriving after process exit but before pipe close', async () => {
        const child = spawn(process.execPath, ['-e', String.raw`
            const { spawn } = require('node:child_process');
            const descendant = spawn(process.execPath, ['-e',
                "setTimeout(() => process.stderr.write('Error: provider startup failed\\n'), 50)"
            ], { stdio: ['ignore', 'ignore', 'inherit'] });
            descendant.unref();
            process.exitCode = 7;
        `], { stdio: ['ignore', 'ignore', 'pipe'] });
        const diagnostics = captureSessionStartupDiagnostics(child);
        let exited = false;
        child.once('exit', () => { exited = true; });
        await diagnostics.closed;
        expect(exited).toBe(true);
        const message = diagnostics.describeFailure('Startup failed');
        expect(message).toContain('exitCode=7');
        expect(message).toContain('Error: provider startup failed');
    });

    it('captures actual OS spawn errors even when no child PID was allocated', async () => {
        const child = spawn(join(process.cwd(), randomUUID()), [], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        const diagnostics = captureSessionStartupDiagnostics(child);
        await diagnostics.closed;
        expect(child.pid).toBeUndefined();
        expect(diagnostics.describeFailure('Startup failed')).toContain('ENOENT');
    });
});

describe('absolute session startup deadline', () => {
    it('expires queued restores without starting them or releasing the existing owner', async () => {
        const queues = new Map<string, Promise<void>>();
        const events: string[] = [];
        let release!: () => void;
        const first = runSerial(queues, 'same-session', async () => {
            events.push('first:start');
            await new Promise<void>(resolve => { release = resolve; });
            events.push('first:end');
        });
        const expired = runSerial(queues, 'same-session', async () => {
            events.push('expired:spawn');
        }, Date.now() + 25);
        const third = runSerial(queues, 'same-session', async () => { events.push('third'); });
        try {
            await expect(expired).rejects.toThrow('deadline expired while queued');
            await runSerial(queues, 'unrelated-session', async () => { events.push('peer'); });
            expect(events).toEqual(['first:start', 'peer']);
            expect(queues.has('same-session')).toBe(true);
        } finally {
            release();
            await Promise.all([first, third]);
        }
        expect(events).toEqual(['first:start', 'peer', 'first:end', 'third']);
        expect(queues.size).toBe(0);
    });

    it('rejects a deadline exhausted by preflight before starting a provider', async () => {
        const deadlineAt = Date.now() + 10;
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(() => requireSessionStartupBudget(deadlineAt)).toThrow('deadline expired');
        let started = false;
        await expect(runSerial(new Map(), 'expired', async () => { started = true; }, deadlineAt))
            .rejects.toThrow('deadline expired');
        expect(started).toBe(false);
    });

    it('leaves a started operation in charge of its deadline and cleanup', async () => {
        const queues = new Map<string, Promise<void>>();
        const result = await runSerial(queues, 'running', async () => {
            // The startup awaiter owns running-process cleanup. A queue timer
            // must not return early and let the next operation overtake it.
            await new Promise(resolve => setTimeout(resolve, 40));
            return 'cleanup-complete';
        }, Date.now() + 20);
        expect(result).toBe('cleanup-complete');
        await Promise.all(queues.values());
        expect(queues.size).toBe(0);
    });

    it('does not reset an expired deadline to the default 58-second timeout', async () => {
        const events: string[] = [];
        const result = await waitForTrackedSessionStartup({
            pid: process.pid,
            deadlineAt: Date.now() - 1,
            timeoutMs: 58_000,
            register: () => { events.push('register'); },
            unregister: () => { events.push('unregister'); },
            // No process exists in this timer test; OS teardown is tested separately.
            terminate: async () => { events.push('terminate'); return true; },
            complete: () => { throw new Error('Expired startup must not become ready'); },
        });
        expect(result.type).toBe('error');
        expect(events).toEqual(['register', 'terminate', 'unregister']);
    }, 2_000);

    it('preserves diagnostics on timeout until the actual child is terminated', async () => {
        const child = spawn(process.execPath, ['-e', String.raw`
            process.stderr.write('Error: provider handshake stalled\npassword=P@ssw0rd!\n');
            setInterval(() => {}, 1000);
        `], { stdio: ['ignore', 'ignore', 'pipe'] });
        const diagnostics = captureSessionStartupDiagnostics(child);
        await once(child.stderr!, 'data');
        try {
            const result = await waitForTrackedSessionStartup({
                pid: child.pid!, deadlineAt: Date.now() + 20, timeoutMs: 58_000,
                register: () => {}, unregister: diagnostics.clear,
                describeFailure: diagnostics.describeFailure,
                terminate: async () => { child.kill(); await diagnostics.closed; return true; },
                complete: () => { throw new Error('No provider readiness was emitted'); },
            });
            expect(result.type).toBe('error');
            if (result.type === 'error') {
                expect(result.errorMessage).toContain('Session startup timeout');
                expect(result.errorMessage).toContain('provider handshake stalled');
                expect(result.errorMessage).not.toContain('P@ssw0rd!');
            }
            expect(diagnostics.describeFailure('After cleanup')).not.toContain('provider handshake stalled');
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill();
            await diagnostics.closed;
        }
    });
});
