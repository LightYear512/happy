#!/usr/bin/env node
/**
 * Bang command end-to-end smoke.
 *
 * Sends `!help` from the web app and verifies the bang command goes
 * through the full pipeline:
 *
 *   web textarea (text: "!help")
 *     → POST /v3/sessions/<id>/messages
 *     → server RPC → daemon spawn-happy-session
 *     → CLI runClaude isBangCommand → executeBangCommand
 *     → handler emits help text via client.sendSessionEvent
 *     → server → web DOM renders "📖 快捷命令" or "!auth"
 *
 * Why a separate fixture from three-tier-smoke:
 *   bang commands DO NOT trigger an LLM turn — runClaude intercepts
 *   the message before it reaches the SDK. So three-tier-smoke's
 *   cli_turn_completed / cli_outbox_flushed assertions don't apply
 *   here; we replace them with bang-specific log + DOM probes.
 *
 * Assertions:
 *   - new-session URL pattern matches /session/<cuid>
 *   - one POST /v3/sessions/<id>/messages was issued
 *   - daemon log gains "spawn-happy-session" + "Spawning session"
 *   - CLI session log contains "[bang] Executing command: !help"
 *   - web DOM eventually shows the help text marker
 *
 * Prerequisites: same as three-tier-smoke.cjs (env up + puppeteer).
 *
 * Usage:
 *   node environments/scenarios/bang-command-smoke.cjs
 *   yarn scenario:bang-command-smoke
 *   yarn scenario:bang-command-smoke --command "!help"
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function resolvePuppeteer() {
    const candidates = [
        path.join(REPO_ROOT, 'node_modules', 'puppeteer'),
        '/tmp/happy-web-probe/node_modules/puppeteer',
    ];
    for (const dir of candidates) {
        try { return require(dir); } catch {}
    }
    try { return require('puppeteer'); } catch {}
    console.error(JSON.stringify({
        ok: false, kind: 'bang_command_smoke',
        error: { code: 'puppeteer_not_found', fix: 'npm install --no-save puppeteer (in repo root)' },
    }, null, 2));
    process.exit(2);
}

function parseArgs() {
    const args = process.argv.slice(2);
    const get = (flag, dflt) => {
        const i = args.indexOf(flag);
        return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
    };
    return {
        command: get('--command', '!help'),
        // Marker text expected to appear in the web DOM after bang dispatch.
        // For !help the dispatcher emits "📖 快捷命令" in the first line.
        domMarker: get('--marker', '📖 快捷命令'),
        timeoutMs: parseInt(get('--timeout', '60000'), 10),
        keepBrowser: args.includes('--keep-browser'),
    };
}

function readEnvSnapshot() {
    let raw;
    try {
        raw = execSync('yarn -s env:current --json', { cwd: REPO_ROOT, encoding: 'utf-8' });
    } catch (e) {
        return { ok: false, error: { code: 'env_current_failed', message: e.message } };
    }
    try { return JSON.parse(raw); }
    catch (e) { return { ok: false, error: { code: 'env_current_unparseable', message: e.message } }; }
}

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

(async () => {
    const args = parseArgs();
    const startedAt = Date.now();
    const puppeteer = resolvePuppeteer();

    const snap = readEnvSnapshot();
    if (!snap.ok) {
        console.log(JSON.stringify({ ok: false, kind: 'bang_command_smoke', error: snap.error }, null, 2));
        process.exit(3);
    }
    if (snap.health.server !== 'ok' || snap.health.web !== 'ok' || snap.health.daemon !== 'ok') {
        console.log(JSON.stringify({
            ok: false, kind: 'bang_command_smoke',
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
    page.on('request', r => {
        if (r.method() === 'POST' && r.url().startsWith(snap.serverUrl)) {
            serverPosts.push({ url: r.url() });
        }
    });

    const events = [];
    const pushEvt = (n, extra = {}) => events.push({ t: Date.now() - startedAt, name: n, ...extra });

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

        pushEvt('type_bang_command', { command: args.command });
        await page.click('textarea[placeholder="What would you like to work on?"]');
        await page.type('textarea[placeholder="What would you like to work on?"]', args.command);

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
        pushEvt('session_route', { sessionId });

        // Wait for daemon spawn signal + extract CLI pid.
        pushEvt('wait_for_daemon_spawn');
        const spawnDeadline = startedAt + args.timeoutMs;
        let spawnSeen = false;
        let cliPid = null;
        let daemonDelta = '';
        while (Date.now() < spawnDeadline) {
            if (daemonLog) {
                daemonDelta = readLogTail(daemonLog, daemonLogOffsetBefore);
                if (/Spawning session/.test(daemonDelta)) {
                    spawnSeen = true;
                    const m = daemonDelta.match(/Spawned process with PID (\d+)/);
                    if (m) cliPid = parseInt(m[1], 10);
                    break;
                }
            }
            await new Promise(r => setTimeout(r, 300));
        }
        pushEvt('daemon_spawn', { spawnSeen, cliPid });

        // Wait for CLI bang dispatch in the spawned CLI's own log.
        let bangDispatched = false;
        let cliLogPath = null;
        if (cliPid && spawnSeen) {
            pushEvt('wait_for_cli_bang_dispatch');
            const cliDeadline = startedAt + args.timeoutMs;
            while (Date.now() < cliDeadline) {
                cliLogPath = findCliSessionLog(snap.happyHomeDir, cliPid);
                if (cliLogPath) break;
                await new Promise(r => setTimeout(r, 300));
            }
            if (cliLogPath) {
                const cmdName = args.command.replace(/^!/, '').split(/\s+/)[0].toLowerCase();
                const dispatchPattern = new RegExp(`\\[bang\\] Executing command: !${cmdName}`, 'i');
                while (Date.now() < cliDeadline) {
                    const content = fs.readFileSync(cliLogPath, 'utf-8');
                    if (dispatchPattern.test(content)) {
                        bangDispatched = true;
                        break;
                    }
                    await new Promise(r => setTimeout(r, 300));
                }
            }
            pushEvt('cli_bang_dispatch', { bangDispatched, cliLogPath });
        }

        // Wait for the help text marker to render in the web DOM.
        pushEvt('wait_for_dom_marker', { marker: args.domMarker });
        let domMarkerSeen = false;
        try {
            await page.waitForFunction(
                marker => (document.body.innerText || '').includes(marker),
                { timeout: 15_000 },
                args.domMarker,
            );
            domMarkerSeen = true;
        } catch {}
        pushEvt('dom_marker', { domMarkerSeen });

        const hasMessagePost = serverPosts.some(p =>
            /\/v3\/sessions\/.+\/messages/.test(p.url));

        const assertions = {
            session_route_matched: !!sessionId,
            message_post_issued: hasMessagePost,
            daemon_spawn_seen: spawnSeen,
            cli_bang_dispatched: bangDispatched,
            web_dom_marker_seen: domMarkerSeen,
        };
        const allPass = Object.values(assertions).every(Boolean);

        summary = {
            ok: allPass,
            kind: 'bang_command_smoke',
            command: args.command,
            domMarker: args.domMarker,
            durationMs: Date.now() - startedAt,
            sessionId: sessionId ?? null,
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
            },
            timeline: events,
            envSnapshot: { name: snap.name, serverUrl: snap.serverUrl, webUrl: snap.webUrl },
        };
        if (!allPass) exitCode = 1;
    } catch (e) {
        summary = {
            ok: false,
            kind: 'bang_command_smoke',
            durationMs: Date.now() - startedAt,
            error: { code: 'probe_exception', message: e.message },
            timeline: events,
        };
        exitCode = 1;
    } finally {
        if (!args.keepBrowser) await browser.close();
    }

    console.log(JSON.stringify(summary, null, 2));
    process.exit(exitCode);
})();
