/** Real process-tree tests; never signal a PID not created by this test. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { killProcessTree } from './processKill';

describe.skipIf(process.platform === 'win32')('killProcessTree — actual detached descendants', () => {
    const children: ChildProcess[] = [];
    afterEach(async () => {
        await Promise.all(children.splice(0).map((child) => killProcessTree(child.pid!)));
    });
    it('rejects invalid, init and self targets before signaling', async () => {
        for (const pid of [0, 1, -1, NaN, process.pid]) {
            await expect(killProcessTree(pid)).rejects.toThrow('invalid process tree owner');
        }
    });
    it('terminates a separate descendant group even when the parent cannot handle TERM', async () => {
        const child = spawn(process.execPath, ['-e', `
            const { spawn } = require('node:child_process');
            process.on('SIGTERM', () => {});
            const sidecar = spawn(process.execPath, ['-e',
                'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready")'],
                { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
            sidecar.stdout.once('data', () => console.log(sidecar.pid));
        `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        const closed = once(child, 'close');
        const [chunk] = await once(child.stdout!, 'data');
        const sidecarPid = Number(String(chunk).trim());
        expect(sidecarPid).toBeGreaterThan(1);
        await killProcessTree(child.pid!);
        await closed;
        const groups = execFileSync('ps', ['-A', '-o', 'pgid='], { encoding: 'utf8' })
            .trim().split(/\s+/u).map(Number);
        expect(groups.length).toBeGreaterThan(0);
        expect(groups.every(group => Number.isSafeInteger(group) && group > 0)).toBe(true);
        expect(groups).not.toContain(child.pid);
        expect(groups).not.toContain(sidecarPid);
    }, 10_000);
});
