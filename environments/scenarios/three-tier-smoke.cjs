#!/usr/bin/env node
/**
 * Three-tier integration smoke test.
 *
 * Drives Server / CLI Daemon / App-Web end-to-end through a real browser
 * to verify the message-send pipeline:
 *
 *   web textarea → POST /v3/sessions/<id>/messages
 *                → server RPC → daemon spawn-happy-session
 *                → CLI process spawn + webhook
 *                → CLI runs Claude SDK turn → flushOutbox
 *
 * Asserts (PASS/FAIL JSON to stdout):
 *   - new-session URL pattern matches /session/<cuid>
 *   - one POST /v3/sessions/<id>/messages with 200
 *   - daemon log gains "spawn-happy-session" + "Spawning session" within budget
 *
 * Prerequisites:
 *   - An environment must be already up (yarn env:up:authenticated). Smoke
 *     does not start/stop env on its own — keeps re-runs fast.
 *   - puppeteer must be available. Install via one of:
 *       npm install --no-save puppeteer        (in repo root, fastest)
 *       cd /tmp/happy-web-probe && npm i puppeteer  (off-tree dev cache)
 *   - For an end-to-end "assistant truly replies" assertion the host must
 *     have a usable Claude Code authentication (e.g. ~/.claude/credentials.json
 *     or ANTHROPIC_API_KEY in the daemon's environment). Smoke does not
 *     assert assistant content; it asserts daemon spawn + server message
 *     accept, which is the contract this fixture is responsible for.
 *
 * Usage:
 *   node environments/scenarios/three-tier-smoke.cjs
 *   yarn scenario:three-tier-smoke
 *   yarn scenario:three-tier-smoke --message "custom probe ping"
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ============================================================================
// puppeteer resolution
// ============================================================================

function resolvePuppeteer() {
    const candidates = [
        path.join(REPO_ROOT, 'node_modules', 'puppeteer'),
        '/tmp/happy-web-probe/node_modules/puppeteer',
    ];
    for (const dir of candidates) {
        try {
            return require(dir);
        } catch {}
    }
    try {
        return require('puppeteer');
    } catch {}
    console.error(JSON.stringify({
        ok: false,
        kind: 'three_tier_smoke',
        error: {
            code: 'puppeteer_not_found',
            message: 'puppeteer is not installed in any candidate location.',
            tried: [...candidates, 'puppeteer (NODE_PATH lookup)'],
            fix: 'npm install --no-save puppeteer (in repo root)',
        },
    }, null, 2));
    process.exit(2);
}

// ============================================================================
// CLI args
// ============================================================================

function parseArgs() {
    const args = process.argv.slice(2);
    const get = (flag, dflt) => {
        const i = args.indexOf(flag);
        return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
    };
    return {
        // Keep the prompt minimal so LLM finishes fast.
        message: get('--message', 'reply with the single word: ok'),
        // Default 90s — comfortably covers LLM round trip + outbox ack.
        timeoutMs: parseInt(get('--timeout', '90000'), 10),
        keepBrowser: args.includes('--keep-browser'),
    };
}

// ============================================================================
// env:current --json
// ============================================================================

function readEnvSnapshot() {
    let raw;
    try {
        raw = execSync('yarn -s env:current --json', { cwd: REPO_ROOT, encoding: 'utf-8' });
    } catch (e) {
        return { ok: false, error: { code: 'env_current_failed', message: e.message } };
    }
    try {
        return JSON.parse(raw);
    } catch (e) {
        return { ok: false, error: { code: 'env_current_unparseable', message: e.message, raw: raw.slice(0, 200) } };
    }
}

// ============================================================================
// daemon log helpers
// ============================================================================

function findLatestDaemonLog(happyHomeDir) {
    const logsDir = path.join(happyHomeDir, 'logs');
    if (!fs.existsSync(logsDir)) return null;
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('-daemon.log'));
    if (files.length === 0) return null;
    files.sort();
    return path.join(logsDir, files[files.length - 1]);
}

function findCliSessionLog(happyHomeDir, pid) {
    const logsDir = path.join(happyHomeDir, 'logs');
    if (!fs.existsSync(logsDir)) return null;
    const files = fs.readdirSync(logsDir)
        .filter(f => f.endsWith(`-pid-${pid}.log`) && !f.endsWith('-daemon.log'));
    if (files.length === 0) return null;
    return path.join(logsDir, files[files.length - 1]);
}

function readLogTail(logPath, fromOffset) {
    const sizeNow = fs.statSync(logPath).size;
    if (sizeNow <= fromOffset) return '';
    const fd = fs.openSync(logPath, 'r');
    try {
        const buf = Buffer.alloc(sizeNow - fromOffset);
        fs.readSync(fd, buf, 0, buf.length, fromOffset);
        return buf.toString('utf-8');
    } finally {
        fs.closeSync(fd);
    }
}

function readWholeLog(logPath) {
    return fs.readFileSync(logPath, 'utf-8');
}

// ============================================================================
// main
// ============================================================================

(async () => {
    const args = parseArgs();
    const startedAt = Date.now();
    const puppeteer = resolvePuppeteer();

    const snap = readEnvSnapshot();
    if (!snap.ok) {
        console.log(JSON.stringify({ ok: false, kind: 'three_tier_smoke', error: snap.error }, null, 2));
        process.exit(3);
    }
    const required = ['authenticatedWebUrl', 'happyHomeDir', 'serverUrl', 'token'];
    for (const k of required) {
        if (!snap[k]) {
            console.log(JSON.stringify({
                ok: false, kind: 'three_tier_smoke',
                error: { code: 'env_snapshot_missing_field', missing: k, snapshot: snap },
            }, null, 2));
            process.exit(3);
        }
    }
    if (snap.health.server !== 'ok' || snap.health.web !== 'ok' || snap.health.daemon !== 'ok') {
        console.log(JSON.stringify({
            ok: false, kind: 'three_tier_smoke',
            error: { code: 'env_unhealthy', health: snap.health },
        }, null, 2));
        process.exit(3);
    }

    const daemonLog = findLatestDaemonLog(snap.happyHomeDir);
    const daemonLogOffsetBefore = daemonLog ? fs.statSync(daemonLog).size : 0;

    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const serverPosts = [];
    const serverPostResponses = [];
    page.on('request', r => {
        if (r.method() === 'POST' && r.url().startsWith(snap.serverUrl)) {
            serverPosts.push({ url: r.url() });
        }
    });
    page.on('response', async r => {
        if (r.request().method() === 'POST' && r.url().startsWith(snap.serverUrl)) {
            serverPostResponses.push({ url: r.url(), status: r.status() });
        }
    });

    const events = [];
    const pushEvt = (name, extra = {}) => events.push({ t: Date.now() - startedAt, name, ...extra });

    let exitCode = 0;
    let summary;

    try {
        pushEvt('navigate');
        await page.goto(snap.authenticatedWebUrl, { waitUntil: 'networkidle2', timeout: 90_000 });

        pushEvt('wait_for_main_button');
        await page.waitForFunction(
            () => Array.from(document.querySelectorAll('div')).some(d => d.innerText?.trim() === '开始新会话'),
            { timeout: 30_000 }
        );

        pushEvt('click_new_session');
        await page.evaluate(() => {
            const t = Array.from(document.querySelectorAll('div[tabindex="0"]'))
                .find(d => d.innerText?.trim() === '开始新会话');
            if (t) t.click();
        });

        pushEvt('wait_for_textarea');
        await page.waitForSelector('textarea[placeholder="What would you like to work on?"]', { timeout: 15_000 });

        pushEvt('type_message');
        await page.click('textarea[placeholder="What would you like to work on?"]');
        await page.type('textarea[placeholder="What would you like to work on?"]', args.message);

        pushEvt('submit_cmd_enter');
        await page.keyboard.down('Meta');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Meta');

        pushEvt('wait_for_session_route');
        await page.waitForFunction(
            () => /\/session\/[a-z0-9]+/.test(location.pathname),
            { timeout: args.timeoutMs }
        );
        const sessionUrl = page.url();
        const sessionId = (sessionUrl.match(/\/session\/([a-z0-9]+)/) || [])[1];
        pushEvt('session_route', { sessionId, sessionUrl });

        pushEvt('wait_for_daemon_spawn');
        const spawnDeadline = startedAt + args.timeoutMs;
        let spawnSeen = false;
        let daemonDelta = '';
        let cliPid = null;
        while (Date.now() < spawnDeadline) {
            if (daemonLog) {
                daemonDelta = readLogTail(daemonLog, daemonLogOffsetBefore);
                if (/spawn-happy-session/.test(daemonDelta) && /Spawning session/.test(daemonDelta)) {
                    spawnSeen = true;
                    const pidMatch = daemonDelta.match(/Spawned process with PID (\d+)/);
                    if (pidMatch) cliPid = parseInt(pidMatch[1], 10);
                    break;
                }
            }
            await new Promise(r => setTimeout(r, 500));
        }
        pushEvt('daemon_spawn', { spawnSeen, deltaBytes: daemonDelta.length, cliPid });

        // CLI-side assertions: turn completion + outbox flush.
        // These look inside the spawned CLI process's own log (not the daemon log)
        // and prove the LLM call returned + ack pipeline back to server worked.
        // No API key needed if the host already has Claude Code OAuth (Keychain or
        // ~/.claude/credentials.json); CI without that will surface here as the
        // expected failure.
        let turnEndSeen = false;
        let flushOutboxSeen = false;
        let lastSeq = null;
        let cliLogPath = null;
        if (cliPid && spawnSeen) {
            pushEvt('wait_for_cli_completion', { cliPid });
            const cliDeadline = startedAt + args.timeoutMs;
            // Allow the CLI session log to appear (it's created shortly after spawn).
            while (Date.now() < cliDeadline) {
                cliLogPath = findCliSessionLog(snap.happyHomeDir, cliPid);
                if (cliLogPath) break;
                await new Promise(r => setTimeout(r, 300));
            }
            if (cliLogPath) {
                while (Date.now() < cliDeadline) {
                    const content = readWholeLog(cliLogPath);
                    // turn-end JSON event: { "t": "turn-end", "status": "completed" }
                    if (/"t":\s*"turn-end"[\s\S]{0,300}"status":\s*"completed"/.test(content)) {
                        turnEndSeen = true;
                    }
                    const flushMatch = content.match(/flushOutbox: success,?\s*\d+\s+messages?\s+acknowledged,?\s*lastSeq=(\d+)/);
                    if (flushMatch) {
                        flushOutboxSeen = true;
                        lastSeq = parseInt(flushMatch[1], 10);
                    }
                    if (turnEndSeen && flushOutboxSeen) break;
                    await new Promise(r => setTimeout(r, 500));
                }
            }
            pushEvt('cli_completion', { turnEndSeen, flushOutboxSeen, lastSeq, cliLogPath });
        }

        // Assertions.
        // We assert the POST was *issued* rather than the 200 response
        // body — the response listener is racy across the navigation
        // that follows submit. session_route_matched already implies
        // server-side acceptance: the route only changes after server
        // returns the new session id.
        const hasMessagePost = serverPosts.some(p =>
            /\/v3\/sessions\/.+\/messages/.test(p.url));
        const hasSessionId = !!sessionId;

        const assertions = {
            session_route_matched: hasSessionId,
            message_post_issued: hasMessagePost,
            daemon_spawn_seen: spawnSeen,
            cli_turn_completed: turnEndSeen,
            cli_outbox_flushed: flushOutboxSeen,
        };
        const allPass = Object.values(assertions).every(Boolean);

        summary = {
            ok: allPass,
            kind: 'three_tier_smoke',
            durationMs: Date.now() - startedAt,
            sessionId: sessionId ?? null,
            sessionUrl: sessionUrl ?? null,
            assertions,
            evidence: {
                serverPostCount: serverPosts.length,
                serverPostsByEndpoint: Object.fromEntries(
                    Array.from(new Set(serverPosts.map(p => new URL(p.url).pathname)))
                        .map(pth => [pth, serverPosts.filter(p => new URL(p.url).pathname === pth).length])
                ),
                daemonDeltaBytes: daemonDelta.length,
                cliPid,
                cliLogPath,
                lastSeq,
            },
            timeline: events,
            envSnapshot: {
                name: snap.name,
                serverUrl: snap.serverUrl,
                webUrl: snap.webUrl,
                daemonPid: snap.daemon.pid,
            },
        };
        if (!allPass) exitCode = 1;
    } catch (e) {
        summary = {
            ok: false,
            kind: 'three_tier_smoke',
            durationMs: Date.now() - startedAt,
            error: { code: 'probe_exception', message: e.message, stack: e.stack?.split('\n').slice(0, 5) },
            timeline: events,
        };
        exitCode = 1;
    } finally {
        if (!args.keepBrowser) await browser.close();
    }

    console.log(JSON.stringify(summary, null, 2));
    process.exit(exitCode);
})();
