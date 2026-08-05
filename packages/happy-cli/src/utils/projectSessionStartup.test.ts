import { afterEach, describe, expect, it } from 'vitest';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureProjectWatch, installHappySessionEnvironment, reportProjectError, runProjectSessionClose,
    runProjectSessionInput, runProjectSessionStartup, runProjectSessionStop, runProjectSessionTurnEnd } from './projectSessionStartup';

const workspaces: string[] = [];

async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'happy-project-startup-'));
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

describe('project virtual-session startup', () => {
    it('silently skips a project without XC v2', async () => {
        const root = await workspace();
        const messages: string[] = [];
        await runProjectSessionStartup({ workspace: root, nativeSessionId: 'happy-1', notify: (value) => messages.push(value) });
        await expect(runProjectSessionStop({ workspace: root, nativeSessionId: 'happy-1', notify: (value) => messages.push(value) })).resolves.toBeNull();
        expect(messages).toEqual([]);
    });

    it('runs once at Codex restore and publishes the visible message outside the model turn', async () => {
        const root = await workspace();
        await entry(root, `process.stdout.write(JSON.stringify({ systemMessage:
          process.env.XC_HOST + ':' + process.env.XC_CONVERSATION_ID }));\n`);
        const messages: string[] = [];
        await runProjectSessionStartup({ workspace: root, nativeSessionId: 'happy-2', notify: (value) => messages.push(value) });
        expect(messages).toEqual(['happy:happy-2']);
    });

    it('uses the same native Happy ID for startup and later input', async () => {
        const root = await workspace();
        const calls = join(root, 'calls.jsonl');
        await entry(root, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ action: process.argv[3], conversation:
  process.env.XC_CONVERSATION_ID, native: process.env.HAPPY_CHAT_ID }) + '\\n');
process.stdout.write(process.argv[3] === 'startup'
  ? JSON.stringify({ systemMessage: 'ready:' + process.env.XC_CONVERSATION_ID })
  : JSON.stringify({ hookSpecificOutput: { additionalContext: 'XC_INPUT_CONTEXT' } }));
`);
        const messages: string[] = [];
        await runProjectSessionStartup({ workspace: root, nativeSessionId: 'native-1',
            notify: (value) => messages.push(value) });
        const context = await runProjectSessionInput({ workspace: root,
            nativeSessionId: 'native-1', notify: (value) => messages.push(value) });
        expect(messages).toEqual(['ready:native-1']);
        expect(context).toBe('XC_INPUT_CONTEXT');
        expect((await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))).toEqual([
            { action: 'startup', conversation: 'native-1', native: 'native-1' },
            { action: 'input', conversation: 'native-1', native: 'native-1' },
        ]);
    });

    it('resolves Node from PATH for every XC invocation after the runtime changes', async () => {
        const root = await workspace();
        const calls = join(root, 'runtime-calls.txt');
        await entry(root, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, process.env.XC_TEST_NODE_SLOT + '\\n');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'XC_INPUT_CONTEXT' } }));
`);
        const env = Object.fromEntries(Object.entries(process.env)
            .filter(([key]) => key.toLowerCase() !== 'path'));
        env.XC_TEST_REAL_NODE = process.execPath;
        for (const [index, slot] of ['old', 'current'].entries()) {
            const bin = join(root, slot, 'bin');
            const launcher = join(bin, process.platform === 'win32' ? 'node.exe' : 'node');
            await mkdir(bin, { recursive: true });
            if (process.platform === 'win32') {
                try { await link(process.execPath, launcher); }
                catch { await copyFile(process.execPath, launcher); }
            } else {
                await writeFile(launcher, '#!/bin/sh\nexec "$XC_TEST_REAL_NODE" "$@"\n');
                await chmod(launcher, 0o755);
            }
            env.PATH = bin;
            env.XC_TEST_NODE_SLOT = slot;
            await runProjectSessionInput({ workspace: root, nativeSessionId: `native-${slot}`,
                notify: () => {}, env });
            if (index === 0) await rm(join(root, slot), { recursive: true, force: true });
        }
        expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(['old', 'current']);
    });

    it('overwrites stale provider-thread variables with the native Happy ID', () => {
        const env = { XC_HOST: 'happy', XC_CONVERSATION_ID: 'provider-thread', CODEX_THREAD_ID: 'provider-thread' };
        installHappySessionEnvironment('happy-native', env);
        expect(env).toEqual({
            XC_HOST: 'happy', XC_CONVERSATION_ID: 'happy-native', XC_HOST_NAME: 'Happy',
            HAPPY_CHAT_ID: 'happy-native', CODEX_THREAD_ID: 'provider-thread',
        });
    });

    it('surfaces a startup failure without blocking the Happy session', async () => {
        const root = await workspace();
        await entry(root, `process.stdout.write('not-json');\n`);
        const messages: string[] = [];
        expect(await runProjectSessionStartup({ workspace: root, nativeSessionId: 'happy-3',
            notify: (value) => messages.push(value) })).toBe(false);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(/^旧版本迁移错误：/u);
    });

    it('binds the persisted local id and payload digest to input, and closes through the same host CLI', async () => {
        const root = await workspace();
        const calls = join(root, 'bound-calls.jsonl');
        await entry(root, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`);
        const localId = `xc-msg-v1-${'a'.repeat(64)}`;
        await runProjectSessionInput({ workspace: root, nativeSessionId: 'native-bound', localId,
            messageText: 'verified command', notify: () => {} });
        await runProjectSessionClose({ workspace: root, nativeSessionId: 'native-bound', notify: () => {} });
        await runProjectSessionTurnEnd({ workspace: root, nativeSessionId: 'native-bound', status: 'cancelled', notify: () => {} });
        const digest = `sha256:${createHash('sha256').update('verified command').digest('hex')}`;
        const rows = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
        const turnToken = rows[0]?.at(-1);
        expect(turnToken).toMatch(/^xc-turn-v1-[a-f0-9]{64}$/u);
        expect(rows).toEqual([
            ['host', 'input', '--workspace', root, '--local-id', localId, '--payload-digest', digest,
                '--turn-token', turnToken],
            ['host', 'close', '--workspace', root],
        ]);
    });

    it('ends only the latest model turn with the same stable token', async () => {
        const root = await workspace();
        const calls = join(root, 'turn-calls.jsonl');
        await entry(root, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`);
        const options = { workspace: root, nativeSessionId: 'native-turn', notify: () => {} };
        await runProjectSessionInput(options);
        await runProjectSessionInput(options);
        await runProjectSessionTurnEnd({ ...options, status: 'cancelled' });
        await runProjectSessionTurnEnd({ ...options, status: 'completed' });
        const rows = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
        const firstToken = rows[0]?.at(-1), secondToken = rows[1]?.at(-1);
        expect(firstToken).toMatch(/^xc-turn-v1-[a-f0-9]{64}$/u);
        expect(secondToken).toMatch(/^xc-turn-v1-[a-f0-9]{64}$/u);
        expect(secondToken).not.toBe(firstToken);
        expect(rows[2]).toEqual(['host', 'turn-end', '--workspace', root, '--status', 'cancelled',
            '--turn-token', secondToken]);
        expect(rows).toHaveLength(3);
    });

    it('requests safe stop through the current Happy identity without consuming the active turn token', async () => {
        const root = await workspace();
        const calls = join(root, 'safe-stop-calls.jsonl');
        await entry(root, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2),
  host: process.env.XC_HOST, conversation: process.env.XC_CONVERSATION_ID }) + '\\n');
process.stdout.write(process.argv[3] === 'stop' ? JSON.stringify({ requested: true }) : '{}');
`);
        const options = { workspace: root, nativeSessionId: 'native-stop', notify: () => {} };
        await runProjectSessionInput(options);
        await expect(runProjectSessionStop(options)).resolves.toBe(true);
        await runProjectSessionTurnEnd({ ...options, status: 'completed' });
        const rows = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(rows.map((row) => row.args.slice(0, 2))).toEqual([
            ['host', 'input'], ['host', 'stop'], ['host', 'turn-end'],
        ]);
        expect(rows[1]).toMatchObject({ host: 'happy', conversation: 'native-stop' });
        expect(rows[2].args.at(-1)).toBe(rows[0].args.at(-1));
    });

    it('propagates a verified child-input rejection so no model turn can continue', async () => {
        const root = await workspace();
        await entry(root, `process.stderr.write(JSON.stringify({ code: 'input-rejected' })); process.exit(1);\n`);
        const messages: string[] = [];
        await expect(runProjectSessionInput({ workspace: root, nativeSessionId: 'native-reject',
            messageText: 'direct', notify: (value) => messages.push(value) })).rejects.toThrow();
        expect(messages[0]).toContain('input-rejected');
    });

    it('preserves actionable structured fields after a long XC execFile command', async () => {
        const root = await workspace();
        const failure = { code: 'invalid_operation', message: 'Only Team member zero or Brain can own Task state',
            reason: 'team_controller_required', path: 'To[0]' };
        await entry(root, `process.stderr.write(${JSON.stringify(JSON.stringify(failure))}); process.exit(1);\n`);
        const messages: string[] = [];
        await expect(runProjectSessionInput({ workspace: root, nativeSessionId: 'native-structured',
            localId: `xc-msg-v1-${'a'.repeat(64)}`, messageText: 'verified long command',
            notify: (value) => messages.push(value) })).rejects.toThrow();
        expect(messages).toEqual([`XC v2 输入错误：${JSON.stringify(failure)}`]);
    });

    it('bounds non-JSON child stderr without replacing it with the execFile command', async () => {
        const root = await workspace();
        const failure = `plain child failure:${'x'.repeat(800)}`;
        await entry(root, `process.stderr.write(${JSON.stringify(failure)}); process.exit(1);\n`);
        const messages: string[] = [];
        await expect(runProjectSessionInput({ workspace: root, nativeSessionId: 'native-plain',
            notify: (value) => messages.push(value) })).rejects.toThrow();
        expect(messages).toEqual([`XC v2 输入错误：${failure.slice(0, 500)}`]);
    });

    it('uses the lightweight Watch ensure command for project activity', async () => {
        const root = await workspace();
        const args = join(root, 'args.json');
        await entry(root, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2)));
`);
        await ensureProjectWatch({ workspace: root });
        expect(JSON.parse(await readFile(args, 'utf8'))).toEqual([
            'watch', 'ensure', '--workspace', root,
        ]);
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

    it('returns the existing XC Buglist notice without recreating its format', async () => {
        const root = await workspace();
        await entry(root, `process.stdout.write(JSON.stringify({ ok: true,
  buglistRecord: { notice: '💔 XC 报错\\nID：restore.failed' } }));\n`);
        await expect(reportProjectError({ workspace: root, source: 'happy.restore',
            code: 'restore.failed', message: 'restore failed', reportedBy: 'session-1' }))
            .resolves.toBe('💔 XC 报错\nID：restore.failed');
    });

    it('returns null when a workspace has no XC reporter', async () => {
        const root = await workspace();
        await expect(reportProjectError({ workspace: root, source: 'happy.restore',
            code: 'restore.failed', message: 'restore failed' })).resolves.toBeNull();
    });
});
