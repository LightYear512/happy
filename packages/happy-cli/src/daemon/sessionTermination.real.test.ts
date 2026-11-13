/** Real daemon retirement, including tmux and a stalled native Codex sidecar. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { terminateTrackedSession } from './run';
import type { TrackedSession } from './types';
import { killProcessTree } from '@/utils/processKill';

describe.skipIf(process.platform === 'win32')('daemon retirement — actual processes', () => {
    let directory: string;
    let oldTmux: string | undefined;
    let oldTmuxTmpdir: string | undefined;
    let tmuxStarted = false;
    const children: ChildProcess[] = [];
    let codexPid: number | undefined;
    const alive = (pid: number): boolean => {
        try { process.kill(pid, 0); return true; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
            throw error;
        }
    };
    const tmux = (...args: string[]): string => execFileSync('tmux', ['-f', '/dev/null', ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000,
    });
    beforeEach(async () => {
        directory = await mkdtemp('/private/tmp/xc-disposable/happy-retirement-test.');
        oldTmux = process.env.TMUX;
        oldTmuxTmpdir = process.env.TMUX_TMPDIR;
        delete process.env.TMUX;
        process.env.TMUX_TMPDIR = directory;
    });
    afterEach(async () => {
        try {
            await Promise.all(children.splice(0).filter(child => child.exitCode === null && child.signalCode === null)
                .map(child => killProcessTree(child.pid!)));
            if (codexPid !== undefined && alive(-codexPid)) process.kill(-codexPid, 'SIGKILL');
            if (tmuxStarted) {
                try { tmux('kill-server'); } catch { /* The isolated server may already have exited. */ }
                tmuxStarted = false;
            }
            if (codexPid !== undefined) {
                const deadline = Date.now() + 2_000;
                while (alive(-codexPid) && Date.now() < deadline) await delay(20);
                expect(alive(-codexPid)).toBe(false);
                codexPid = undefined;
            }
            await rm(directory, { recursive: true });
        } finally {
            if (oldTmux === undefined) delete process.env.TMUX; else process.env.TMUX = oldTmux;
            if (oldTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = oldTmuxTmpdir;
        }
    });

    it('rejects an unowned record, then retires the registered daemon child once', async () => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); console.log("ready")'], {
            detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.push(child);
        const closed = once(child, 'close');
        await once(child.stdout!, 'data');
        const session: TrackedSession = { pid: child.pid!, startedBy: 'daemon', childProcess: child };
        const tracked = new Map([[session.pid, session]]);
        expect(await terminateTrackedSession(session.pid, { ...session }, tracked)).toBe(false);
        expect(alive(session.pid)).toBe(true);
        expect(await terminateTrackedSession(session.pid, session, tracked)).toBe(true);
        await closed;
        expect(tracked.size).toBe(0);
        expect(alive(-session.pid)).toBe(false);
    }, 10_000);

    it('cleans a stalled Codex group before retiring its owned tmux window', async () => {
        const readyFile = join(directory, 'ready.json');
        const script = join(directory, 'pane.ts');
        await writeFile(script, `
            import { writeFile } from 'node:fs/promises';
            import { createCodexAppServerClient } from ${JSON.stringify(resolve('src/codex/codexAppServerClient.ts'))};
            import { registerShutdownHandlers } from ${JSON.stringify(resolve('src/utils/shutdownHandlers.ts'))};
            async function main() {
                const client = await createCodexAppServerClient({ cwd: ${JSON.stringify(directory)},
                    processEnv: { PATH: process.env.PATH!, CODEX_HOME: ${JSON.stringify(directory)} } });
                registerShutdownHandlers(() => client.dispose());
                process.kill(-client.processId!, 'SIGSTOP');
                await writeFile(${JSON.stringify(readyFile)}, JSON.stringify({ parent: process.pid, codex: client.processId }));
                setInterval(() => {}, 1000);
            }
            main().catch(error => { console.error(error); process.exitCode = 1; });
        `);
        const loader = resolve('node_modules/tsx/dist/loader.mjs');
        tmux('new-session', '-d', '-s', 'retirement', '-n', 'keeper', 'sleep 60');
        tmuxStarted = true;
        // Keep exited panes so the test also proves explicit window removal.
        tmux('set-window-option', '-g', 'remain-on-exit', 'on');
        tmux('new-window', '-t', 'retirement:', '-n', 'codex',
            `${JSON.stringify(process.execPath)} --import ${JSON.stringify(loader)} ${JSON.stringify(script)}`);
        let ready: { parent: number; codex: number } | undefined;
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
            try { ready = JSON.parse(await readFile(readyFile, 'utf8')) as typeof ready; break; }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                await delay(50);
            }
        }
        if (!ready) throw new Error(`Native Codex did not initialize: ${tmux('capture-pane', '-p', '-t', 'retirement:codex')}`);
        codexPid = ready.codex;
        const session: TrackedSession = { pid: ready.parent, startedBy: 'daemon', tmuxSessionId: 'retirement:codex' };
        const tracked = new Map([[session.pid, session]]);
        expect(await terminateTrackedSession(session.pid, session, tracked)).toBe(true);
        expect(alive(session.pid)).toBe(false);
        expect(alive(-ready.codex)).toBe(false);
        expect(tracked.size).toBe(0);
        expect(tmux('list-windows', '-t', 'retirement', '-F', '#{window_name}').trim()).toBe('keeper');
    }, 20_000);
});
