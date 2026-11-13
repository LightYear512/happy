import { afterEach, describe, expect, it } from 'vitest';
import * as pty from 'node-pty';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BangCommandContext } from './types';
import { startClaudeLoginFlow, isLoginCommandInput, handleLoginBangCommand, type ClaudeLoginResult } from './loginCommand';
import { handleInteractiveInput, hasActiveInteractiveSession, registerInteractiveSession, unregisterInteractiveSession } from './interactiveSession';

const URL = 'https://claude.ai/oauth/authorize?state=invalid-test-state&code_challenge=invalid-test-challenge';
const children: pty.IPty[] = [];
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean): Promise<void> {
    const end = Date.now() + 5000;
    while (!test()) {
        if (Date.now() > end) throw new Error('Timed out waiting for real PTY fixture');
        await pause(10);
    }
}
function fixture(script: string, timeouts: { startupTimeoutMs?: number; authorizationTimeoutMs?: number } = {}) {
    // Real child process and PTY transport; this fixture does not impersonate an OAuth server.
    const child = pty.spawn(process.execPath, ['-e', script], {
        name: 'xterm-256color', cols: 1000, rows: 30, cwd: process.cwd(),
        env: Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined)),
    });
    children.push(child);
    const messages: string[] = [], outcomes: ClaudeLoginResult[] = [];
    let exited = false;
    child.onExit(() => { exited = true; });
    startClaudeLoginFlow(child, {
        sendMessage: text => { messages.push(text); },
        complete: result => { outcomes.push(result); },
        startupTimeoutMs: 5000, authorizationTimeoutMs: 5000, ...timeouts,
    });
    return { child, messages, outcomes, exited: () => exited };
}
const inputFixture = `const rl=require('node:readline').createInterface({input:process.stdin});
process.stdout.write(${JSON.stringify(URL)}+'\\n');
rl.on('line',line=>process.exit(line==='invalid-code#invalid-test-state'?0:7));`;

afterEach(async () => {
    unregisterInteractiveSession();
    for (const child of children.splice(0)) { try { child.kill(); } catch {} }
    await pause(20);
});

describe('native Claude login process lifecycle', () => {
    it('rejects commands/menu input and submits only the authorization code', async () => {
        const run = fixture(inputFixture);
        handleInteractiveInput('early-code');
        await until(() => run.messages.some(text => text.includes(URL)));
        for (const command of ['!login --Claude garry3', '!unknown', '/login', '❇️ @@ 主菜单']) handleInteractiveInput(command);
        await pause(150);
        expect(run.outcomes).toEqual([]);
        expect(run.messages.filter(text => text.includes('请勿重复发送命令'))).toHaveLength(4);
        for (const invalid of ['abc', 'code#', '#state', 'code#state#extra']) handleInteractiveInput(invalid);
        expect(run.messages.filter(text => text.includes('完整粘贴'))).toHaveLength(4);
        handleInteractiveInput('code#wrong-state');
        expect(run.messages.some(text => text.includes('不属于本次登录'))).toBe(true);
        handleInteractiveInput('invalid-code#invalid-test-state');
        await until(() => run.outcomes.length > 0);
        expect(run.outcomes).toEqual([{ success: true }]);
        expect(run.messages.join('\n')).not.toContain('invalid-code#invalid-test-state');
        expect(hasActiveInteractiveSession()).toBe(false);
    });

    it('waits for a complete fragmented URL without inspecting chat UI or success text', async () => {
        const run = fixture(`process.stdout.write(${JSON.stringify(URL.slice(0, 40))});
setTimeout(()=>process.stdout.write(${JSON.stringify(URL.slice(40))}),80);
setTimeout(()=>process.stdout.write('\\n'),160);
setTimeout(()=>process.exit(0),240);`);
        await pause(100);
        expect(run.messages).toEqual([]);
        await until(() => run.outcomes.length > 0);
        expect(run.messages.filter(text => text.includes(URL))).toHaveLength(1);
        expect(run.outcomes).toEqual([{ success: true }]);
    });

    it('does not turn a success-looking output or old credentials into a successful failed process', async () => {
        const run = fixture(`console.log('Login successful.');setTimeout(()=>process.exit(1),20);`);
        await until(() => run.outcomes.length > 0);
        expect(run.outcomes).toEqual([{ success: false, reason: 'exit', exitCode: 1 }]);
        expect(hasActiveInteractiveSession()).toBe(false);
    });

    it('does not accept a signal-terminated login as native exit success', async () => {
        const run = fixture(inputFixture);
        await until(() => run.messages.some(text => text.includes(URL)));
        run.child.kill();
        await until(() => run.outcomes.length > 0);
        expect(run.outcomes[0]).toMatchObject({ success: false, reason: 'exit' });
    });

    it('cancels pending code submission and old exits cannot clear a replacement handler', async () => {
        const run = fixture(inputFixture);
        await until(() => run.messages.some(text => text.includes(URL)));
        handleInteractiveInput('invalid-code#invalid-test-state');
        handleInteractiveInput('!cancel');
        const received: string[] = [];
        const release = registerInteractiveSession(text => received.push(text));
        await until(run.exited);
        await pause(160);
        handleInteractiveInput('next-flow');
        expect(received).toEqual(['next-flow']);
        expect(run.outcomes).toEqual([{ success: false, reason: 'cancelled' }]);
        release();
    });

    it('expires both startup and browser authorization waits and releases input', async () => {
        const startup = fixture('setInterval(()=>{},1000)', { startupTimeoutMs: 30 });
        await until(() => startup.outcomes.length > 0);
        expect(startup.outcomes).toEqual([{ success: false, reason: 'startup-timeout' }]);
        expect(hasActiveInteractiveSession()).toBe(false);
        const waiting = fixture(inputFixture, { authorizationTimeoutMs: 40 });
        await until(() => waiting.outcomes.length > 0);
        expect(waiting.outcomes).toEqual([{ success: false, reason: 'authorization-timeout' }]);
        await until(waiting.exited);
        expect(waiting.outcomes).toHaveLength(1);
        expect(hasActiveInteractiveSession()).toBe(false);
    });

    it('an old owner cannot unregister the current interactive session', () => {
        const old = registerInteractiveSession(() => {});
        old();
        const received: string[] = [];
        const current = registerInteractiveSession(text => received.push(text));
        old(); handleInteractiveInput('current');
        expect(received).toEqual(['current']);
        current(); expect(hasActiveInteractiveSession()).toBe(false);
    });

    it.each(['!login garry3', '！login garry3', '/login', '❇️ @@ 主菜单', '!anything', '@l'])(
        'recognizes control input %s before any PTY write', text => expect(isLoginCommandInput(text)).toBe(true),
    );
});

// Opt in on a host with Claude installed. No account authorization is completed.
it.runIf(process.env.HAPPY_NATIVE_LOGIN_TEST === '1')('starts the real native login through the bang handler and cancels cleanly', async () => {
    const keys = ['CCS_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDECODE', 'BROWSER'] as const;
    const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const isolated = mkdtempSync(join(tmpdir(), 'happy-native-login-'));
    process.env.CCS_DIR = join(isolated, 'ccs');
    process.env.CLAUDE_CONFIG_DIR = join(isolated, 'empty-config');
    process.env.CLAUDECODE = '1';
    process.env.BROWSER = '/usr/bin/true';
    const messages: string[] = [];
    let ready = 0;
    // Capture the delivery boundary locally; the login subprocess itself is real.
    const context = { flavor: 'codex', isConsoleSession: true, client: {
        sendCodexMessage(message: { message?: string }) { if (message.message) messages.push(message.message); },
        sendSessionEvent(event: { type: string }) { if (event.type === 'ready') ready++; },
    } } as unknown as BangCommandContext;
    try {
        const result = await handleLoginBangCommand('--Claude native-login-check', context);
        expect(JSON.stringify(result.message)).toContain('正在登录');
        const deadline = Date.now() + 20000;
        while (!messages.some(text => text.includes('/oauth/authorize'))) {
            if (Date.now() > deadline) throw new Error('Native login did not produce an OAuth URL');
            await pause(20);
        }
        handleInteractiveInput('!login --Claude another-account');
        handleInteractiveInput('not-an-authorization-code');
        expect(messages.some(text => text.includes('请勿重复发送命令'))).toBe(true);
        expect(messages.some(text => text.includes('完整粘贴'))).toBe(true);
        handleInteractiveInput('!cancel');
        await until(() => ready === 1);
        expect(messages.some(text => text.includes('登录已取消'))).toBe(true);
        expect(messages.some(text => text.includes('登录成功'))).toBe(false);
        expect(hasActiveInteractiveSession()).toBe(false);
    } finally {
        if (hasActiveInteractiveSession()) handleInteractiveInput('!cancel');
        for (const key of keys) {
            if (before[key] === undefined) delete process.env[key];
            else process.env[key] = before[key];
        }
    }
}, 25000);
