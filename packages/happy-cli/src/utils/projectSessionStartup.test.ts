import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    ensureProjectWatch,
    installHappySessionEnvironment,
    reportProjectError,
    runProjectSessionClose,
    runProjectSessionStartup,
    runProjectSessionStop,
} from './projectSessionStartup';

const workspaces: string[] = [];
const disposableRoot = '/private/tmp/xc-disposable';

async function workspace(): Promise<string> {
    await mkdir(disposableRoot, { recursive: true });
    const root = await mkdtemp(join(disposableRoot, 'happy-project-startup.'));
    workspaces.push(root);
    return root;
}

async function entry(root: string, source: string): Promise<void> {
    const directory = join(root, 'xcoding-v2');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(directory, 'xc'), source);
}

afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('project virtual-session lifecycle', () => {
    it('silently skips a project without XC v2', async () => {
        const root = await workspace();
        const messages: string[] = [];
        await expect(runProjectSessionStartup({ workspace: root, nativeSessionId: 'happy-1',
            notify: (value) => messages.push(value) })).resolves.toBe(true);
        await expect(runProjectSessionStop({ workspace: root, nativeSessionId: 'happy-1',
            notify: (value) => messages.push(value) })).resolves.toBeNull();
        await expect(runProjectSessionClose({ workspace: root, nativeSessionId: 'happy-1',
            notify: (value) => messages.push(value) })).resolves.toBeUndefined();
        expect(messages).toEqual([]);
    });

    it('publishes startup context outside the human input path', async () => {
        const root = await workspace();
        await entry(root, `process.stdout.write(JSON.stringify({ systemMessage:
          process.env.XC_HOST + ':' + process.env.XC_CONVERSATION_ID }));\n`);
        const messages: string[] = [];
        await runProjectSessionStartup({ workspace: root, nativeSessionId: 'happy-2',
            notify: (value) => messages.push(value) });
        expect(messages).toEqual(['happy:happy-2']);
    });

    it('uses the native Happy identity for lifecycle calls', async () => {
        const root = await workspace();
        const calls = join(root, 'calls.jsonl');
        await entry(root, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ action: process.argv[3],
  conversation: process.env.XC_CONVERSATION_ID, native: process.env.HAPPY_CHAT_ID }) + '\\n');
process.stdout.write(process.argv[3] === 'startup'
  ? JSON.stringify({ systemMessage: 'ready' })
  : process.argv[3] === 'stop' ? JSON.stringify({ requested: true }) : '{}');
`);
        const notify = () => {};
        await runProjectSessionStartup({ workspace: root, nativeSessionId: 'native-1', notify });
        await runProjectSessionStop({ workspace: root, nativeSessionId: 'native-1', notify });
        await runProjectSessionClose({ workspace: root, nativeSessionId: 'native-1', notify });
        expect((await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
            .toEqual([
                { action: 'startup', conversation: 'native-1', native: 'native-1' },
                { action: 'stop', conversation: 'native-1', native: 'native-1' },
                { action: 'close', conversation: 'native-1', native: 'native-1' },
            ]);
    });

    it('overwrites stale provider-thread variables with the native Happy ID', () => {
        const env = { HAPPY_CHAT_ID: 'stale', XC_HOST: 'codex', XC_CONVERSATION_ID: 'stale',
            XC_HOST_NAME: 'Codex' };
        installHappySessionEnvironment('native-bound', env);
        expect(env).toEqual({ HAPPY_CHAT_ID: 'native-bound', XC_HOST: 'happy',
            XC_CONVERSATION_ID: 'native-bound', XC_HOST_NAME: 'Happy' });
    });

    it('keeps startup failure visible without blocking the Happy session', async () => {
        const root = await workspace();
        await entry(root, `process.stderr.write('startup failed'); process.exit(1);\n`);
        const messages: string[] = [];
        await expect(runProjectSessionStartup({ workspace: root, nativeSessionId: 'native-fail',
            notify: (value) => messages.push(value) })).resolves.toBe(false);
        expect(messages.join('\n')).toContain('startup failed');
    });

    it('requests safe stop through the current Happy identity', async () => {
        const root = await workspace();
        await entry(root, `process.stdout.write(JSON.stringify({ requested: true }));\n`);
        await expect(runProjectSessionStop({ workspace: root, nativeSessionId: 'native-stop',
            notify: () => {} })).resolves.toBe(true);
    });

    it('coalesces concurrent Watch ensures for one workspace', async () => {
        const root = await workspace();
        const calls = join(root, 'calls.txt');
        await entry(root, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, 'x\\n');
await new Promise((resolve) => setTimeout(resolve, 100));
`);
        await Promise.all(Array.from({ length: 20 }, () => ensureProjectWatch({ workspace: root })));
        expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(['x']);
    });

    it('returns the existing XC Buglist notice', async () => {
        const root = await workspace();
        await entry(root, `process.stdout.write(JSON.stringify({ ok: true,
  buglistRecord: { notice: '💔 XC 报错\\nID：restore.failed' } }));\n`);
        await expect(reportProjectError({ workspace: root, source: 'happy.restore',
            code: 'restore.failed', message: 'restore failed', reportedBy: 'session-1' }))
            .resolves.toBe('💔 XC 报错\nID：restore.failed');
    });
});
