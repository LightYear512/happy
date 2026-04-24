/**
 * Codex Child Process Env Builder
 *
 * Single source of truth for the env handed to a child codex process.
 *
 * Codex CLI's Rust reqwest client reads proxy env vars once at Client::builder()
 * time from the real process env — it does NOT consult any .env file loaded at
 * runtime. So a daemon started without proxy env (e.g. autostart, explorer-
 * launched) would spawn codex with no proxy, causing intermittent direct-connect
 * failures or wss CONNECT failures against chatgpt.com / auth.openai.com.
 *
 * This module materializes ~/.codex/.env proxy entries into the child env BEFORE
 * spawning, and mirrors upper↔lower case (Reqwest historically only honors the
 * lowercase form while Windows/cmd typically only exposes the uppercase).
 *
 * Used by:
 *   - bang/loginCommand.ts   (codex login PTY spawn)
 *   - codex/runCodexAppServer.ts (codex app-server stdio spawn)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

/**
 * Proxy env var pairs (uppercase/lowercase). Reqwest historically only honors the
 * lowercase form, while Windows/cmd typically only exposes the uppercase. We mirror
 * both directions (never overwriting) and parse both cases from ~/.codex/.env.
 */
export const CODEX_PROXY_KEY_PAIRS: ReadonlyArray<readonly [upper: string, lower: string]> = [
    ['HTTPS_PROXY', 'https_proxy'],
    ['HTTP_PROXY', 'http_proxy'],
    ['NO_PROXY', 'no_proxy'],
    ['ALL_PROXY', 'all_proxy'],
];

/** Env keys whose values get included in the spawn-time childEnv diagnostic snapshot. */
export const CODEX_DIAGNOSTIC_ENV_KEYS = /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|REQUESTS_CA_BUNDLE|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|CODEX_|OPENAI_|XDG_|LANG|LC_|LOCALE|TZ|HOME|USERPROFILE|TMPDIR|TEMP|TMP|PATH|COMSPEC|SHELL)/i;

export interface CodexEnvBuildOptions {
    /** Base env to start from. Defaults to `process.env`. */
    baseEnv?: NodeJS.ProcessEnv;
    /** Path to the dotenv file to read proxy keys from. Defaults to `~/.codex/.env`. */
    dotenvPath?: string;
    /** Log prefix tag, e.g. `'!login:codex'` or `'CodexAppServer'`. */
    logTag?: string;
    /** Keys to delete from the copied env before augmentation (e.g. `CODEX_HOME` for login flow). */
    keysToDelete?: readonly string[];
    /** Whether to emit `logger.info` reports for inject/mirror. Defaults to true. */
    emitLogs?: boolean;
}

export interface CodexEnvBuildResult {
    /** The augmented env to pass to spawn(). */
    env: Record<string, string>;
    /** What dotenv inject did, per proxy key. */
    dotenvInjectReport: Record<string, string>;
    /** What proxy upper↔lower mirror did, per key. */
    proxyMirrorReport: Record<string, string>;
    /** Sanitized snapshot of what codex sees (auth values masked). */
    envSnapshot: Record<string, string>;
}

/**
 * Build the env handed to a child codex process.
 *
 * Pipeline:
 *   1. Copy `baseEnv` (string values only)
 *   2. Delete optional keys (login flow uses this for `CODEX_HOME` so codex
 *      falls back to `~/.codex`)
 *   3. Inject proxy keys from `dotenvPath` if absent in env (case-insensitive
 *      check — never overwrites a value the user already set)
 *   4. Mirror upper↔lower proxy pairs so reqwest and Windows both see the value
 *   5. Build a masked diagnostic snapshot suitable for logging
 *
 * INVARIANT: never overwrites a value already present in `baseEnv` (either
 * case). The .env file is a fallback source, not a force-override.
 */
export function buildCodexChildEnv(opts: CodexEnvBuildOptions = {}): CodexEnvBuildResult {
    const baseEnv = opts.baseEnv ?? process.env;
    const dotenvPath = opts.dotenvPath ?? join(homedir(), '.codex', '.env');
    const tag = opts.logTag ?? 'codex';
    const emitLogs = opts.emitLogs ?? true;

    // Step 1: copy baseEnv (string values only — drops `undefined` entries)
    const childEnv: Record<string, string> = {};
    for (const key of Object.keys(baseEnv)) {
        const value = baseEnv[key];
        if (typeof value === 'string') {
            childEnv[key] = value;
        }
    }

    // Step 2: delete user-requested keys
    if (opts.keysToDelete) {
        for (const key of opts.keysToDelete) {
            delete childEnv[key];
        }
    }

    // Step 3: dotenv inject (proxy keys only)
    const dotenvInjectReport: Record<string, string> = {};
    if (existsSync(dotenvPath)) {
        try {
            const dotenvText = readFileSync(dotenvPath, 'utf-8');
            for (const rawLine of dotenvText.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line || line.startsWith('#')) continue;
                const eq = line.indexOf('=');
                if (eq < 0) continue;
                const key = line.slice(0, eq).trim();
                let val = line.slice(eq + 1).trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                const keyLower = key.toLowerCase();
                const matchedPair = CODEX_PROXY_KEY_PAIRS.find(([, lower]) => lower === keyLower);
                if (!matchedPair) {
                    // Surface unmatched lines at debug level so users debugging
                    // "my proxy isn't getting picked up" can see we read the line
                    // but didn't recognize the key. Common cause: `export HTTPS_PROXY=...`
                    // with shell `export ` prefix. Node's motdotla/dotenv does not
                    // strip it, and we follow the same convention here.
                    if (emitLogs) {
                        logger.debug(`[${tag}] dotenv line ignored (key '${key}' is not a known PROXY pair)`);
                    }
                    continue;
                }
                const [upperKey, lowerKey] = matchedPair;
                if (childEnv[lowerKey] === undefined && childEnv[upperKey] === undefined) {
                    childEnv[lowerKey] = val;
                    childEnv[upperKey] = val;
                    dotenvInjectReport[`${lowerKey}/${upperKey}`] = `injected from ${dotenvPath}`;
                } else {
                    dotenvInjectReport[lowerKey] = 'skipped (already in childEnv)';
                }
            }
        } catch (err) {
            if (emitLogs) {
                logger.warn(`[${tag}] failed to parse ${dotenvPath}: ${(err as Error).message}`);
            }
        }
    }
    if (emitLogs && Object.keys(dotenvInjectReport).length > 0) {
        logger.info(`[${tag}] dotenv proxy inject: ${JSON.stringify(dotenvInjectReport)}`);
    }

    // Step 4: upper↔lower proxy mirror
    const proxyMirrorReport: Record<string, string> = {};
    for (const [upper, lower] of CODEX_PROXY_KEY_PAIRS) {
        const upperVal = childEnv[upper];
        const lowerVal = childEnv[lower];
        if (upperVal && !lowerVal) {
            childEnv[lower] = upperVal;
            proxyMirrorReport[lower] = `mirrored ← ${upper}`;
        } else if (lowerVal && !upperVal) {
            childEnv[upper] = lowerVal;
            proxyMirrorReport[upper] = `mirrored ← ${lower}`;
        } else if (upperVal && lowerVal) {
            proxyMirrorReport[`${upper}/${lower}`] = upperVal === lowerVal
                ? 'both set, identical (no-op)'
                : 'both set, DIFFERENT (left as-is, user explicit)';
        }
    }
    if (emitLogs && Object.keys(proxyMirrorReport).length > 0) {
        logger.info(`[${tag}] proxy env mirror: ${JSON.stringify(proxyMirrorReport)}`);
    }

    // Step 5: diagnostic snapshot — values for sensitive keys are masked.
    const maskProxyAuth = (v: string): string => v.replace(/\/\/[^@/]*@/, '//<auth>@');
    const envSnapshot: Record<string, string> = {};
    for (const [k, v] of Object.entries(childEnv)) {
        if (!CODEX_DIAGNOSTIC_ENV_KEYS.test(k)) continue;
        if (k === 'PATH') {
            envSnapshot[k] = `<${v.split(/[;:]/).length} entries>`;
        } else if (/PROXY/i.test(k)) {
            envSnapshot[k] = maskProxyAuth(v);
        } else if (/^(OPENAI_API_KEY|OPENAI_TOKEN)$/i.test(k)) {
            envSnapshot[k] = `<set, len=${v.length}>`;
        } else {
            envSnapshot[k] = v;
        }
    }
    if (emitLogs) {
        logger.info(`[${tag}] childEnv snapshot: ${JSON.stringify(envSnapshot)}`);
    }

    return { env: childEnv, dotenvInjectReport, proxyMirrorReport, envSnapshot };
}
