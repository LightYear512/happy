/** Exercise binary selection and initialization against the installed Codex. */
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCodexAppServerClient, type CodexAppServerClient } from '../codexAppServerClient';

describe.skipIf(process.platform === 'win32')('Codex binary selection — actual process', () => {
    let directory: string;
    let client: CodexAppServerClient | undefined;
    let previousOverride: string | undefined;
    beforeEach(async () => {
        directory = await mkdtemp('/private/tmp/xc-disposable/happy-codex-binary-test.');
        previousOverride = process.env.HAPPY_CODEX_APP_SERVER_BIN;
    });
    afterEach(async () => {
        await client?.dispose();
        client = undefined;
        if (previousOverride === undefined) delete process.env.HAPPY_CODEX_APP_SERVER_BIN;
        else process.env.HAPPY_CODEX_APP_SERVER_BIN = previousOverride;
        await rm(directory, { recursive: true });
    });
    it('uses an explicit real executable and strips inherited thread/startup identity', async () => {
        process.env.HAPPY_CODEX_APP_SERVER_BIN = execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();
        client = await createCodexAppServerClient({
            cwd: directory,
            processEnv: {
                PATH: process.env.PATH!, CODEX_HOME: directory,
                CODEX_THREAD_ID: 'must-not-inherit', HAPPY_SESSION_STARTUP_DEADLINE_MS: '123',
            },
        });
        await expect(client.request('account/read')).resolves.toHaveProperty('account');
        const childEnvironment = execFileSync('ps', ['eww', '-p', String(client.processId), '-o', 'command='], { encoding: 'utf8' });
        expect(childEnvironment).not.toContain('CODEX_THREAD_ID=');
        expect(childEnvironment).not.toContain('HAPPY_SESSION_STARTUP_DEADLINE_MS=');
    }, 20_000);
    it('reports a missing executable and finishes failed-spawn cleanup', async () => {
        process.env.HAPPY_CODEX_APP_SERVER_BIN = join(directory, 'does-not-exist');
        await expect(createCodexAppServerClient({ cwd: directory })).rejects.toThrow('Failed to launch Codex');
    }, 5_000);
});
