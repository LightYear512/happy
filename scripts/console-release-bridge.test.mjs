import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { installConsoleBridge, sha256 } from './console-release-bridge.mjs';

function fixture(t) {
    const parent = process.env.HAPPY_CONSOLE_BRIDGE_TEST_ROOT;
    if (!parent) throw new Error('Set HAPPY_CONSOLE_BRIDGE_TEST_ROOT to a disposable test directory');
    const root = mkdtempSync(join(parent, 'console-bridge-'));
    const old = join(root, 'old');
    const next = join(root, 'new');
    for (const [path, name] of [[old, 'old'], [next, 'new']]) {
        mkdirSync(join(path, 'dist'), { recursive: true });
        writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'happy-coder', type: 'module' }));
        writeFileSync(join(path, 'dist', 'main.mjs'), `console.log(${JSON.stringify(name)});`);
        writeFileSync(join(path, 'dist', 'index.mjs'), "import './main.mjs';\n", { mode: 0o444 });
        chmodSync(join(path, 'dist'), 0o555);
    }
    t.after(() => {
        for (const path of [old, next]) chmodSync(join(path, 'dist'), 0o755);
        rmSync(root, { recursive: true, force: true });
    });
    const entry = join(old, 'dist', 'index.mjs');
    return { old, next, entry, digest: sha256(readFileSync(entry)) };
}

const consoleArgs = ['codex', '--happy-starting-mode', 'remote', '--started-by', 'daemon'];
function run(entry, args, consoleFlag) {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.HAPPY_CONSOLE_SESSION;
    if (consoleFlag !== undefined) env.HAPPY_CONSOLE_SESSION = consoleFlag;
    const result = spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

test('only the exact daemon console uses new release; user and daemon entry stay old', t => {
    const f = fixture(t);
    const original = readFileSync(f.entry);
    const installed = installConsoleBridge(f.old, f.next, f.digest);
    assert.deepEqual(readFileSync(installed.originalEntry), original);
    assert.equal(statSync(join(f.old, 'dist')).mode & 0o777, 0o555);
    assert.equal(statSync(f.entry).mode & 0o777, 0o444);
    assert.equal(run(f.entry, consoleArgs, '1'), 'new');
    assert.equal(run(f.entry, consoleArgs), 'old');
    assert.equal(run(f.entry, consoleArgs, '0'), 'old');
    assert.equal(run(f.entry, ['daemon', 'start-sync'], '1'), 'old');
    assert.equal(run(f.entry, [...consoleArgs, '--happy-restore-session', 'session-a'], '1'), 'old');
    assert.equal(run(f.entry, ['codex'], '1'), 'old');
});

test('rejects stale checksum, same release and an unknown launcher without rewriting', t => {
    const f = fixture(t);
    const original = readFileSync(f.entry);
    assert.throws(() => installConsoleBridge(f.old, f.next, '0'.repeat(64)), /checksum/u);
    assert.throws(() => installConsoleBridge(f.old, f.old, f.digest), /distinct/u);
    assert.deepEqual(readFileSync(f.entry), original);
    installConsoleBridge(f.old, f.next, f.digest);
    const bridge = readFileSync(f.entry);
    assert.throws(() => installConsoleBridge(f.old, f.next, sha256(bridge)), /already bridged/u);
    assert.deepEqual(readFileSync(f.entry), bridge);
});

test('refuses conflicting backup and restores directory permissions', t => {
    const f = fixture(t);
    chmodSync(join(f.old, 'dist'), 0o755);
    writeFileSync(join(f.old, 'dist', `index.console-original-${f.digest}.mjs`), 'conflict');
    chmodSync(join(f.old, 'dist'), 0o555);
    assert.throws(() => installConsoleBridge(f.old, f.next, f.digest), /backup conflicts/u);
    assert.equal(sha256(readFileSync(f.entry)), f.digest);
    assert.equal(statSync(join(f.old, 'dist')).mode & 0o777, 0o555);
});
