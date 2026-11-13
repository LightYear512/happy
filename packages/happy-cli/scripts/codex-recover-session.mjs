/** Explicit maintenance of one closed Happy conversation whose native rollout is missing. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function replacementMetadata(current, oldId, newId) {
    assert(uuid.test(oldId) && uuid.test(newId) && oldId !== newId, 'Invalid replacement identities');
    assert.equal(current.flavor, 'codex', 'Conversation backend changed');
    assert(current.claudeSessionId === oldId || current.claudeSessionId === newId,
        'Native identity changed concurrently; refusing to overwrite it');
    return { ...current, claudeSessionId: newId };
}

export function assertNoUnexpectedUsers(rows, lastSeq, decode) {
    assert(Number.isSafeInteger(lastSeq) && lastSeq >= 0);
    for (const row of rows) {
        if (row.seq > lastSeq) {
            assert.notEqual(decode(row).role, 'user', 'New user input arrived during recovery; stop and reconcile the saved history');
        }
    }
}

export function assertRecoveryInputWindow(rows, lastSeq, decode) {
    assert(rows.some(row => row.seq <= lastSeq), 'Input history window was truncated; reconcile before proceeding');
    assertNoUnexpectedUsers(rows, lastSeq, decode);
}

export function validateSeed(seed) {
    assert(typeof seed === 'string' && seed.trim().length > 0 && Buffer.byteLength(seed) <= 20000,
        'Recovery seed must contain 1–20000 UTF-8 bytes');
    return seed;
}

export function isMissingRolloutError(error, threadId) {
    let message;
    try { message = JSON.parse(error.message).message; } catch { return false; }
    return typeof message === 'string' && (message === `no rollout found for thread id ${threadId}` ||
        message.startsWith('failed to resolve rollout path `') &&
        message.endsWith('`: file does not exist') && message.includes(`-${threadId}.jsonl`));
}

async function save(file, value) {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
}

/** Owns only the bounded, tool-free native preparation process, never a Happy owner. */
function nativeServer(options) {
    const env = { ...process.env, CODEX_HOME: options.codexHome };
    for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TURN_ID', 'CODEX_SQLITE_HOME',
        'HAPPY_SESSION_STARTUP_DEADLINE_MS']) delete env[key];
    const child = spawn(options.codexBinary, ['app-server', '--listen', 'stdio://',
        '-c', 'model_reasoning_effort="low"', '-c', 'mcp_servers.openaiDeveloperDocs.enabled=false'], {
        cwd: options.workspace, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    const pending = new Map();
    const events = [];
    let sequence = 0;
    let failure;
    const closed = new Promise(resolve => child.once('close', resolve));
    const fail = error => {
        failure = error;
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
        pending.clear();
    };
    child.on('error', fail);
    child.on('exit', () => fail(new Error('Native preparation process exited')));
    child.stderr.resume(); // Never print stderr, which may contain user data or credentials.
    readline.createInterface({ input: child.stdout }).on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id !== undefined && !message.method) {
            const entry = pending.get(message.id);
            if (!entry) return;
            clearTimeout(entry.timer); pending.delete(message.id);
            if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
            else entry.resolve(message.result);
        } else if (message.method) {
            if (message.id !== undefined) child.stdin.write(JSON.stringify({ id: message.id,
                error: { code: -32000, message: 'Recovery preparation denies tool/server requests' } }) + '\n');
            if (events.length >= 4096) return fail(new Error('Native event budget exceeded'));
            events.push(message);
        }
    });
    const request = (method, params) => new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 45000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    return {
        request,
        async initialize() {
            await request('initialize', { clientInfo: { name: 'happy-recovery-maintenance', version: '1' },
                capabilities: { experimentalApi: true } });
            child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
        },
        async verifyTurn(threadId, text, expected) {
            events.length = 0;
            const { turn } = await request('turn/start', { threadId,
                input: [{ type: 'text', text }], approvalPolicy: 'never',
                sandboxPolicy: { type: 'readOnly' }, effort: 'low' });
            const deadline = Date.now() + 120000;
            while (Date.now() < deadline) {
                if (failure) throw failure;
                if (events.some(e => e.method === 'item/started' &&
                    /tool|commandExecution|fileChange|webSearch|collab/i.test(e.params?.item?.type ?? ''))) {
                    await request('turn/interrupt', { threadId, turnId: turn.id });
                    throw new Error('Unexpected tool activity in recovery preparation');
                }
                const completed = events.find(e => e.method === 'turn/completed' && e.params?.turn?.id === turn.id);
                if (completed) {
                    assert.equal(completed.params.turn.status, 'completed', 'Recovery model turn did not complete');
                    assert(!events.some(e => e.method === 'error'), 'Recovery model reported a provider error');
                    const replies = events.filter(e => e.method === 'item/completed' &&
                        e.params?.item?.type === 'agentMessage').map(e => e.params.item.text);
                    assert(replies.some(reply => reply.trim() === expected), 'Recovery continuity acknowledgement missing');
                    return;
                }
                await delay(100);
            }
            throw new Error('Recovery model turn timed out');
        },
        async close() {
            child.stdin.end();
            await Promise.race([closed, delay(1000)]);
            if (child.exitCode === null && child.signalCode === null) {
                try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
                await Promise.race([closed, delay(1500)]);
            }
            if (child.exitCode === null && child.signalCode === null) {
                try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
                await closed;
            }
        },
    };
}

async function assertClosed(options, expectedBytes) {
    const file = path.join(options.happyHome, 'restore', `${options.sessionId}.closed`);
    const bytes = await fs.readFile(file);
    const data = JSON.parse(bytes);
    assert.equal(data.agent, 'codex');
    assert.equal(path.resolve(data.directory), options.workspace);
    if (expectedBytes) assert.equal(digest(bytes), expectedBytes, 'Closed-session authority changed');
    await assert.rejects(fs.access(file.replace(/\.closed$/, '.json')), { code: 'ENOENT' });
    const state = JSON.parse(await fs.readFile(path.join(options.happyHome, 'daemon.state.json')));
    const result = await fetch(`http://127.0.0.1:${state.httpPort}/list`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000),
    });
    assert(result.ok, 'Cannot observe Happy daemon ownership');
    const list = await result.json();
    assert(Array.isArray(list.children), 'Invalid daemon ownership result');
    assert(!list.children.some(c => c.happySessionId === options.sessionId), 'Target Happy session is running');
    return digest(bytes);
}

async function awaitClosedAfterNotice(options, expectedBytes) {
    // Persisting a reply also wakes the old, missing provider. It cannot reach
    // input-ready; wait for that attempt to fail and close its own authority.
    // A quiet interval avoids observing the closed marker before the wake starts.
    const deadline = Date.now() + 60000;
    let quietSince = Date.now();
    let lastError;
    while (Date.now() < deadline) {
        try {
            await assertClosed(options, expectedBytes);
            if (Date.now() - quietSince >= 5000) return;
        } catch (error) {
            quietSince = Date.now();
            lastError = error;
        }
        await delay(500);
    }
    throw new Error('Old provider has not returned to a closed state', { cause: lastError });
}

async function context(options) {
    assert(/^[a-z0-9-]{1,128}$/i.test(options.sessionId) && uuid.test(options.oldThreadId));
    for (const key of ['happyHome', 'happyLibrary', 'codexHome', 'workspace', 'codexBinary', 'evidence']) {
        assert(path.isAbsolute(options[key]), `${key} must be absolute`);
    }
    const origin = new URL(options.serverUrl);
    assert(origin.protocol === 'https:' && origin.username === '' && origin.password === '');
    process.env.HAPPY_HOME_DIR = options.happyHome;
    process.env.HAPPY_SERVER_URL = origin.origin;
    const lib = await import(pathToFileURL(options.happyLibrary).href);
    const api = await lib.ApiClient.create(await lib.readCredentials());
    const session = await api.restoreSessionById(options.sessionId);
    assert.equal(session.id, options.sessionId);
    assert.equal(session.metadata.flavor, 'codex');
    assert.equal(path.resolve(session.metadata.path), options.workspace);
    const decode = row => {
        const body = lib.decrypt(session.encryptionKey, session.encryptionVariant, lib.decodeBase64(row.content.c));
        assert(body && ['agent', 'user'].includes(body.role), 'Undecodable history');
        return body;
    };
    return { api, session, decode };
}

async function prepare(options) {
    const { api, session } = await context(options);
    assert.equal(session.metadata.claudeSessionId, options.oldThreadId, 'Expected old native identity changed');
    const closedDigest = await assertClosed(options);
    const seed = validateSeed(await fs.readFile(options.seedFile, 'utf8'));
    const rows = await api.getSessionMessages(options.sessionId);
    assert(rows.length > 0 && rows.length <= 150);
    await save(path.join(options.evidence, 'before.json'), { sessionId: session.id,
        metadata: session.metadata, metadataVersion: session.metadataVersion, seq: session.seq, messages: rows });
    await fs.copyFile(path.join(options.happyHome, 'restore', `${options.sessionId}.closed`),
        path.join(options.evidence, 'restore.closed'), fs.constants.COPYFILE_EXCL);
    const token = `RECOVERY_READY_${randomBytes(12).toString('hex')}`;
    const native = nativeServer(options);
    let threadId;
    const policy = { cwd: options.workspace, approvalPolicy: 'never', sandbox: 'read-only' };
    try {
        await native.initialize();
        await assert.rejects(native.request('thread/resume', { ...policy, threadId: options.oldThreadId,
            excludeTurns: true }), error => isMissingRolloutError(error, options.oldThreadId),
        'Original thread must really be missing; no repair is allowed for other errors');
        const result = await native.request('thread/start', policy);
        threadId = result.thread.id;
        assert(uuid.test(threadId) && threadId !== options.oldThreadId);
        await save(path.join(options.evidence, 'candidate.json'), { threadId, oldThreadId: options.oldThreadId });
        await native.verifyTurn(threadId,
            `The user authorized safe recovery of this conversation. This is context restoration only.\n` +
            `Do not execute past tasks, use tools, read files, browse, delegate, send messages, or make changes.\n` +
            `Store the following recovery summary as context. Old queued inputs are historical and paused.\n` +
            `<recovery-summary>\n${seed}\n</recovery-summary>\n` +
            `Continuity token: ${token}\nReply with exactly ${token} and nothing else.`, token);
    } finally { await native.close(); }
    // A second process must actually recover the same durable native history.
    const resumed = nativeServer(options);
    try {
        await resumed.initialize();
        const result = await resumed.request('thread/resume', { ...policy, threadId, excludeTurns: true });
        assert.equal(result.thread.id, threadId);
        await resumed.verifyTurn(threadId,
            'Recovery continuity check only. Do not use tools or execute any task. Return exactly the continuity token from the previous recovery message, without any other text.', token);
    } finally { await resumed.close(); }
    const db = new DatabaseSync(path.join(options.codexHome, 'state_5.sqlite'), { readOnly: true });
    let rollout;
    try { rollout = db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(threadId)?.rollout_path; }
    finally { db.close(); }
    assert(typeof rollout === 'string' && (await fs.stat(rollout)).isFile(), 'New native history was not persisted');
    const bytes = await fs.readFile(rollout);
    assert(bytes.includes(Buffer.from(token)) && bytes.includes(Buffer.from('recovery-summary')));
    const prepared = { at: new Date().toISOString(), sessionId: options.sessionId,
        oldThreadId: options.oldThreadId, newThreadId: threadId, closedDigest, seedDigest: digest(seed),
        lastSeq: Math.max(session.seq, ...rows.map(r => r.seq)), rollout, rolloutDigest: digest(bytes),
        verifiedAcrossRestart: true, toolCalls: 0 };
    await save(path.join(options.evidence, 'prepared.json'), prepared);
    console.log(JSON.stringify({ phase: 'prepared', ...prepared }));
}

async function apply(options) {
    const prepared = JSON.parse(await fs.readFile(path.join(options.evidence, 'prepared.json')));
    assert.equal(prepared.sessionId, options.sessionId);
    assert.equal(prepared.oldThreadId, options.oldThreadId);
    assert.equal(prepared.verifiedAcrossRestart, true);
    assert.equal(prepared.toolCalls, 0);
    assert.equal(digest(await fs.readFile(options.seedFile)), prepared.seedDigest);
    assert.equal(digest(await fs.readFile(prepared.rollout)), prepared.rolloutDigest, 'Prepared native history changed');
    await assertClosed(options, prepared.closedDigest);
    const { api, session, decode } = await context(options);
    assert.equal(session.metadata.claudeSessionId, prepared.oldThreadId, 'Expected old identity changed');
    let rows = await api.getSessionMessages(options.sessionId);
    assertRecoveryInputWindow(rows, prepared.lastSeq, decode);
    const operation = digest(`${options.sessionId}:${prepared.oldThreadId}:${prepared.newThreadId}`);
    const notice = {
        type: 'message', id: `recovery-${operation}`,
        message: '安全恢复：新原生线程已保存恢复摘要，并通过重启续聊检查。原聊天和 XC 任务保留；此前积压输入留作历史，本次不执行旧任务。正在接回原会话，随后等待新指令。',
    };
    // This truthful repair response is the existing input-replay boundary. It does
    // not claim the earlier business tasks were executed or manufacture a cursor.
    const receipt = await api.sessionMessageClient(session).sendCodexMessageOnce({
        messageRole: 'agent', messageType: 'codex', body: notice,
        localId: `xc-msg-v1-${operation}`, timeoutMs: 20000,
    });
    await save(path.join(options.evidence, 'notice.json'), { receipt, notice });
    rows = await api.getSessionMessages(options.sessionId);
    // This is an audited one-session operation, not an atomic general recovery
    // API. Record the exact input window before admitting a metadata change.
    // Any concurrent input requires operator reconciliation; never
    // silently proceed past it or pretend the boundary was atomic.
    await save(path.join(options.evidence, 'input-window.json'), {
        baseline: prepared.lastSeq, boundary: receipt.seq, messages: rows,
    });
    assertRecoveryInputWindow(rows, prepared.lastSeq, decode);
    await awaitClosedAfterNotice(options, prepared.closedDigest);
    const beforeCommit = await api.restoreSessionById(options.sessionId);
    assert.equal(beforeCommit.metadata.claudeSessionId, prepared.oldThreadId, 'Identity changed while the old wake was settling');
    await assertClosed(options, prepared.closedDigest);
    // The old wake may take up to a minute to settle. Recheck the full input
    // window after waiting, including post-notice input. This detects observed
    // concurrent input; it is not an atomic server ownership/input lock.
    rows = await api.getSessionMessages(options.sessionId);
    await save(path.join(options.evidence, 'pre-commit-window.json'), {
        baseline: prepared.lastSeq, boundary: receipt.seq, messages: rows,
    });
    assertRecoveryInputWindow(rows, prepared.lastSeq, decode);
    const writer = api.sessionMetadataClient(beforeCommit);
    try {
        await writer.updateMetadataOnce(current =>
            replacementMetadata(current, prepared.oldThreadId, prepared.newThreadId), 20000);
    } catch (error) {
        // Lost ACK is ambiguous: only the exact prepared new identity proves commit.
        const latest = await api.restoreSessionById(options.sessionId);
        if (latest.metadata.claudeSessionId !== prepared.newThreadId) throw error;
    } finally { writer.close(); }
    const current = await api.restoreSessionById(options.sessionId);
    assert.equal(current.metadata.claudeSessionId, prepared.newThreadId);
    const committed = { at: new Date().toISOString(), sessionId: options.sessionId,
        oldThreadId: prepared.oldThreadId, newThreadId: prepared.newThreadId,
        metadataVersion: current.metadataVersion, recoveryResponseSeq: receipt.seq };
    await save(path.join(options.evidence, 'committed.json'), committed);
    console.log(JSON.stringify({ phase: 'committed', ...committed }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.umask(0o077);
    try {
        const options = JSON.parse(await fs.readFile(process.argv[3], 'utf8'));
        assert(['prepare', 'apply'].includes(process.argv[2]), 'Usage: codex-recover-session.mjs prepare|apply OPTIONS.json');
        if (process.argv[2] === 'prepare') await prepare(options);
        else await apply(options);
    } catch (error) {
        console.error(JSON.stringify({ phase: 'failed', error: String(error) }));
        process.exitCode = 1;
    }
}
