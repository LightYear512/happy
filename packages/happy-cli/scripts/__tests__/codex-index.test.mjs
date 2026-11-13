/** Real SQLite and native Codex integration; no account, network reply, or user data is used. */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { DatabaseSync, backup } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, statSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { inspectIndex, repairIndex, assertIdle } from '../codex-index.mjs';

const root = process.platform === 'darwin' ? '/private/tmp/xc-disposable' : join(tmpdir(), 'xc-disposable');
mkdirSync(root, { recursive: true });
const run = mkdtempSync(join(root, 'happy-index-test-'));
const nativeHome = join(run, 'native'); mkdirSync(nativeHome);
let file;
let native;
let threadPath;
let threadId;
function appServer(home) {
    const env = { ...process.env, CODEX_HOME: home };
    for (const key of ['CODEX_SQLITE_HOME', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TURN_ID']) delete env[key];
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd: run, env, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    const pending = new Map(); let id = 0;
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => { const v = JSON.parse(line); if (pending.has(v.id)) { const p = pending.get(v.id); pending.delete(v.id); clearTimeout(p.timer); v.error ? p.reject(new Error(v.error.message)) : p.resolve(v.result); } });
    return { child, request(method, params) { return new Promise((resolve, reject) => { const rid = ++id; const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15000); pending.set(rid, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id: rid, method, params }) + '\n'); }); }, async close() { child.stdin.end(); if (process.platform === 'win32') child.kill('SIGTERM'); else { try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } await new Promise(resolve => { if (child.exitCode !== null || child.signalCode) resolve(); else child.once('exit', resolve); }); reader.close(); } };
}
before(async () => {
    threadId = randomUUID();
    const date = new Date().toISOString();
    const sessions = join(nativeHome, 'sessions', ...date.slice(0, 10).split('-')); mkdirSync(sessions, { recursive: true });
    threadPath = join(sessions, `rollout-${date.slice(0, 19).replaceAll(':', '-')}-${threadId}.jsonl`);
    writeFileSync(threadPath, JSON.stringify({ timestamp: date, type: 'session_meta', payload: { id: threadId, timestamp: date, cwd: run, originator: 'happy-index-tests', cli_version: '0.154.0', source: 'cli', model_provider: 'openai' } }) + '\n' + JSON.stringify({ timestamp: date, type: 'event_msg', payload: { type: 'user_message', message: 'Index fixture only', images: [], local_images: [], text_elements: [] } }) + '\n');
    native = appServer(nativeHome);
    await native.request('initialize', { clientInfo: { name: 'happy-index-tests', version: '1.0.0' } });
    await native.close(); native = undefined;
    file = readdirSync(nativeHome).find(name => /^state_\d+\.sqlite$/.test(name));
    const db = new DatabaseSync(join(nativeHome, file), { readOnly: true });
    assert.equal(db.prepare('SELECT status FROM backfill_state').all()[0].status, 'complete');
    threadPath = db.prepare('SELECT rollout_path FROM threads WHERE id=?').all(threadId)[0].rollout_path;
    assert.ok(existsSync(threadPath)); db.close();
});
after(async () => { if (native) await native.close(); console.log(`Index test artifacts: ${run}`); });
async function fixture() {
    const work = mkdtempSync(join(run, 'case-'));
    const source = join(work, 'source'); const home = join(work, 'target');
    mkdirSync(source); mkdirSync(home);
    for (const path of [source, home]) symlinkSync(join(nativeHome, 'sessions'), join(path, 'sessions'));
    const original = new DatabaseSync(join(nativeHome, file), { readOnly: true });
    await backup(original, join(source, file)); original.close();
    return { home, reference: nativeHome, sources: [source], work, backups: join(work, 'backups') };
}
async function incomplete(options) {
    const db = new DatabaseSync(join(options.sources[0], file), { readOnly: true });
    await backup(db, join(options.home, file)); db.close();
    const target = new DatabaseSync(join(options.home, file));
    target.exec("UPDATE backfill_state SET status='running'"); target.close();
}

test('copies a native completed index into an independent missing target', async () => {
    const options = await fixture();
    assert.equal(inspectIndex(options.home).status, 'missing');
    assert.equal((await repairIndex(options)).status, 'repaired');
    assert.equal(inspectIndex(options.home).status, 'ready');
    assert.notEqual(statSync(join(options.home, file)).ino, statSync(join(options.sources[0], file)).ino);
    const db = new DatabaseSync(join(options.home, file), { readOnly: true });
    assert.equal(db.prepare('SELECT rollout_path FROM threads WHERE id=?').all(threadId)[0].rollout_path, threadPath); db.close();
});
test('preserves incomplete target database and every original thread', async () => {
    const options = await fixture(); await incomplete(options);
    const original = readFileSync(join(options.home, file));
    assert.equal((await repairIndex(options)).status, 'repaired');
    assert.deepEqual(readFileSync(join(options.backups, file)), original);
    const db = new DatabaseSync(join(options.home, file), { readOnly: true });
    assert.ok(db.prepare('SELECT id FROM threads WHERE id=?').all(threadId)[0]); db.close();
});
test('leaves a healthy target unchanged, even with an open database', async () => {
    const options = await fixture(); await repairIndex(options);
    const before = readFileSync(join(options.home, file));
    const db = new DatabaseSync(join(options.home, file));
    try { assert.equal((await repairIndex(options)).status, 'ready'); } finally { db.close(); }
    assert.deepEqual(readFileSync(join(options.home, file)), before);
});
test('refuses an occupied incomplete target without changing it', async () => {
    const options = await fixture(); await incomplete(options);
    const db = new DatabaseSync(join(options.home, file));
    try { await assert.rejects(repairIndex(options), /占用|空闲/); } finally { db.close(); }
    assert.equal(inspectIndex(options.home).status, 'incomplete');
});
test('refuses a running Codex account even before a database exists', async () => {
    const options = await fixture(); const server = appServer(options.home);
    try {
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.throws(() => assertIdle(options.home), /正在使用|占用/);
    } finally { await server.close(); }
});
test('rejects source migration checksum mismatch', async () => {
    const options = await fixture(); const db = new DatabaseSync(join(options.sources[0], file));
    db.exec("UPDATE _sqlx_migrations SET checksum=X'01' WHERE version=(SELECT MAX(version) FROM _sqlx_migrations)"); db.close();
    assert.equal((await repairIndex(options)).status, 'native-required');
    assert.equal(existsSync(join(options.home, file)), false);
});
test('rejects sources from a different shared-history directory', async () => {
    const options = await fixture(); const other = join(options.work, 'other'); mkdirSync(other);
    const db = new DatabaseSync(join(nativeHome, file), { readOnly: true }); await backup(db, join(other, file)); db.close();
    mkdirSync(join(other, 'sessions')); options.sources = [other];
    assert.equal((await repairIndex(options)).status, 'native-required');
});
test('rejects missing rollout paths and preserves incomplete original', async () => {
    const options = await fixture(); await incomplete(options);
    const db = new DatabaseSync(join(options.sources[0], file)); db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(join(options.work, 'missing.jsonl'), threadId); db.close();
    assert.equal((await repairIndex(options)).status, 'native-required');
    assert.equal(inspectIndex(options.home).status, 'incomplete');
    assert.ok(existsSync(join(options.backups, file)));
});
test('rejects source rows pointing outside shared history', async () => {
    const options = await fixture(); const outside = join(options.work, 'outside.jsonl'); writeFileSync(outside, '{}');
    const db = new DatabaseSync(join(options.sources[0], file)); db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(outside, threadId); db.close();
    assert.equal((await repairIndex(options)).status, 'native-required');
});
test('rejects loss of original thread ids', async () => {
    const options = await fixture(); await incomplete(options);
    const db = new DatabaseSync(join(options.sources[0], file)); db.prepare('DELETE FROM threads WHERE id=?').run(threadId); db.close();
    assert.equal((await repairIndex(options)).status, 'native-required');
    assert.equal(inspectIndex(options.home).status, 'incomplete');
});
test('rejects account-specific section data in either source or target', async () => {
    for (const target of [false, true]) {
        const options = await fixture(); if (target) await incomplete(options);
        const db = new DatabaseSync(join(target ? options.home : options.sources[0], file));
        db.exec("UPDATE thread_sections SET name='Private'"); db.close();
        assert.equal((await repairIndex(options)).status, 'native-required');
    }
});
test('rejects unknown source schema and database symlinks', async () => {
    const options = await fixture(); const db = new DatabaseSync(join(options.sources[0], file)); db.exec('CREATE TABLE account_private_data (value TEXT)'); db.close();
    assert.equal((await repairIndex(options)).status, 'native-required');
    symlinkSync(join(options.sources[0], file), join(options.home, file));
    await assert.rejects(repairIndex(options), /独立文件/);
});

test('uses native migration for an older database filename without seeding over it', async () => {
    const options = await fixture(); await incomplete(options);
    const oldName = 'state_0.sqlite'; renameSync(join(options.home, file), join(options.home, oldName));
    assert.equal((await repairIndex(options)).status, 'native-required');
    assert.ok(existsSync(join(options.home, oldName)));
    assert.ok(existsSync(join(options.backups, oldName)));
    assert.equal(existsSync(join(options.home, file)), false);
    assert.equal(inspectIndex(options.home, options.reference).status, 'missing');
});

test('preserves unknown private tables in an incomplete target', async () => {
    const options = await fixture(); await incomplete(options);
    const db = new DatabaseSync(join(options.home, file)); db.exec("CREATE TABLE account_private_data (value TEXT); INSERT INTO account_private_data VALUES ('keep')"); db.close();
    assert.equal((await repairIndex(options)).status, 'native-required');
    const saved = new DatabaseSync(join(options.home, file), { readOnly: true });
    assert.equal(saved.prepare('SELECT value FROM account_private_data').all()[0].value, 'keep'); saved.close();
});
