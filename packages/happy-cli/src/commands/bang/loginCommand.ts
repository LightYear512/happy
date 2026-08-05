import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync, copyFileSync, readdirSync, statSync, lstatSync, readlinkSync, realpathSync, chmodSync, constants as fsConstants, accessSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import * as yaml from 'js-yaml';
import { logger } from '@/ui/logger';
import {
    hasActiveInteractiveSession,
    registerInteractiveSession,
    unregisterInteractiveSession,
} from './interactiveSession';
import { SEPARATOR, codeBlock, parseCodexFlag, rejectCodexFlagInSession, type BangCommandContext, type BangCommandResult } from './types';
import { getCodexInstancePath, getHappyHome, registerCodexProfile, readCodexDefaultProfile, setCodexDefaultProfile, readCodexProfiles, type AuthFlavor } from './ccsProfiles';
import { buildCodexChildEnv } from '@/codex/codexEnvBuilder';

const PROFILE_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Parsed result of `!login` bang args. `kind: 'ok'` with `profileName: undefined`
 * signals the no-args branch (caller renders an account list).
 */
export type ParsedLoginArgs =
    | {
        kind: 'ok';
        profileName: string | undefined;
        targetAgent: AuthFlavor;
    }
    | { kind: 'error'; message: string };

/**
 * Pure parser for `!login` args — no PTY, no fs, no ctx.client side effects,
 * so it can be unit-tested independently. See loginCommand.test.ts.
 */
export function parseLoginArgs(
    args: string,
    ctxFlavor: 'claude' | 'codex' | 'gemini' | undefined,
): ParsedLoginArgs {
    const { cleanArgs, hasCodexFlag } = parseCodexFlag(args);
    const parts = cleanArgs.split(/\s+/).filter(Boolean);

    let profileName: string | undefined;
    for (const p of parts) {
        if (!p.startsWith('--') && profileName === undefined) {
            profileName = p;
        }
    }

    if (profileName !== undefined && !PROFILE_NAME_REGEX.test(profileName)) {
        return {
            kind: 'error',
            message: '❌ 无效的配置名称\n\n字母开头，仅含字母/数字/_/-',
        };
    }

    // gemini/undefined fall back to claude — matches authCommand.resolveAuthFlavor contract
    const targetAgent: AuthFlavor = hasCodexFlag
        ? 'codex'
        : (ctxFlavor === 'codex' ? 'codex' : 'claude');

    return {
        kind: 'ok',
        profileName,
        targetAgent,
    };
}

function getCcsDir(): string {
    if (process.env.CCS_DIR) return process.env.CCS_DIR;
    if (process.env.CCS_HOME) return join(process.env.CCS_HOME, '.ccs');
    return join(homedir(), '.ccs');
}

function sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

function getInstancePath(profileName: string): string {
    return join(getCcsDir(), 'instances', sanitizeName(profileName));
}

/**
 * Strip terminal escape sequences and TUI artifacts, preserving logical whitespace.
 *
 * Key insight: TUI frameworks (ink) use ANSI cursor positioning instead of real
 * spaces/newlines. We replace positioning sequences with appropriate whitespace
 * so text boundaries are preserved (e.g., URL doesn't merge with following text).
 */
function stripTerminalOutput(text: string): string {
    return text
        // --- Phase 1: Replace cursor POSITIONING sequences with whitespace ---
        // Vertical positioning → newline (H=absolute, f=absolute, A=up, B=down, E=next line, F=prev line)
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B\[[\d;]*[HABEFf]/g, '\n')
        // Horizontal forward positioning → space (C=forward, G=column absolute)
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B\[[\d;]*[CG]/g, ' ')
        // Cursor backward (D) → remove (going back doesn't add content)
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B\[[\d;]*D/g, '')

        // --- Phase 2: Remove all remaining CSI sequences (style, color, erase, mode) ---
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B\[[\x20-\x3F]*[\x30-\x3F]*[\x40-\x7E]/g, '')

        // --- Phase 3: Remove non-CSI escape sequences ---
        // OSC sequences: ESC] ... (ST or BEL)
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
        // DCS/PM/APC sequences
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B[P^_][^\x1B]*\x1B\\/g, '')
        // Simple escape sequences: ESC + single char
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B[()][A-Z0-9]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B[>=<#]/g, '')
        // Any remaining ESC + char
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B./g, '')

        // --- Phase 4: Clean up control characters and TUI artifacts ---
        // Control characters (except newline/tab/space)
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // Box-drawing and block Unicode characters used by TUI
        .replace(/[─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┘├┤┬┴┼╋╌╍╎╏═║╔╗╚╝╟╠╡╢╣╤╥╦╧╨╩╪╫╬▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕╭╮╯╰╱╲╳╴╵╶╷╸╹╺╻╼╽╾╿·•…‥‧]+/g, '')

        // --- Phase 5: Normalize whitespace ---
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+$/gm, '')
        .trim();
}

/**
 * Strip ANSI sequences without adding whitespace. Keeps text continuous.
 * Used for URL extraction where line-wrap positioning must not break the URL.
 */
export function stripAnsiOnly(text: string): string {
    return text
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B\[[^A-Za-z]*[A-Za-z]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B[P^_][^\x1B]*\x1B\\/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B./g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Analyze PTY output buffer and decide what action to take.
 * Returns:
 * - `{ action: 'auto-respond', response: string }` — send response to PTY, discard buffer
 * - `{ action: 'forward-url', url: string }` — OAuth URL detected, forward to mobile
 * - `{ action: 'discard' }` — not enough data yet, discard after timeout
 * - `{ action: 'forward' }` — post-login output, forward to mobile
 */
export type PtyAction =
    | { action: 'auto-respond'; response: string }
    | { action: 'forward-url'; url: string }
    | { action: 'already-authenticated' }
    | { action: 'discard' }
    | { action: 'forward' };

export function analyzePtyOutput(buffer: string, loginUrlSent: boolean, loginCommandSent: boolean): PtyAction {
    if (!loginUrlSent) {
        // URL extraction: strip ANSI without adding whitespace (keeps URL intact across line wraps).
        // Then strip trailing Claude UI text that merges with the URL.
        const continuous = stripAnsiOnly(buffer);
        const urlMatch = continuous.match(/https:\/\/[^\s]*\/oauth\/authorize[^\s]*/);
        if (urlMatch) {
            const url = urlMatch[0]
                .replace(/Paste.*$/, '')
                .replace(/Enter.*$/, '')
                .replace(/Esc.*$/, '')
                .replace(/>+$/, '');
            return { action: 'forward-url', url };
        }

        // Keyword detection: strip with whitespace preservation (proper word boundaries).
        const cleanBuffer = stripTerminalOutput(buffer);

        // "Not logged in" → send /login command (only once to avoid loop)
        if (!loginCommandSent && cleanBuffer.includes('Not logged in')) {
            return { action: 'auto-respond', response: '/login\r' };
        }

        // Interactive prompts — ink Select expects Enter to confirm pre-selected first option.
        if (
            cleanBuffer.includes('Select login method')
            || cleanBuffer.includes('trust this folder')
            || cleanBuffer.includes('Choose the text style')
        ) {
            return { action: 'auto-respond', response: '\r' };
        }

        // Already logged in — keychain has valid token, Claude entered main UI.
        // Only detect before /login is sent; after /login the screen may re-render
        // with "Welcome back" text but we're already in the OAuth flow.
        if (!loginCommandSent && cleanBuffer.includes('Welcome back')) {
            return { action: 'already-authenticated' };
        }

        // Recent Claude versions may render the authenticated main screen without
        // "Welcome back". Require the version header, input prompt, and shortcut
        // footer together so selection prompts cannot trigger a forced /login.
        const hasClaudeVersionHeader = /\bClaude Code v\d+(?:\.\d+)+\b/.test(cleanBuffer);
        const hasMainInputPrompt = /(?:^|\n)[^\S\r\n]*❯(?:[^\S\r\n]|$)/.test(cleanBuffer)
            && cleanBuffer.includes('? for shortcuts');
        if (!loginCommandSent && hasClaudeVersionHeader && hasMainInputPrompt) {
            return { action: 'already-authenticated' };
        }

        return { action: 'discard' };
    }

    return { action: 'forward' };
}

const CLAUDE_LOGIN_PRE_OAUTH_TIMEOUT_MS = 60_000;
const MAX_NODE_TIMEOUT_MS = 2_147_483_647;

export function createClaudeLoginPreAuthDeadline(
    onTimeout: () => void,
    timeoutMs = CLAUDE_LOGIN_PRE_OAUTH_TIMEOUT_MS,
): { clear(): void } {
    if (
        !Number.isSafeInteger(timeoutMs)
        || timeoutMs < 0
        || timeoutMs > MAX_NODE_TIMEOUT_MS
    ) {
        throw new RangeError('Claude pre-OAuth timeout is outside the supported range');
    }

    let active = true;
    const timer = setTimeout(() => {
        if (!active) return;
        active = false;
        onTimeout();
    }, timeoutMs);

    return {
        clear(): void {
            if (!active) return;
            active = false;
            clearTimeout(timer);
        },
    };
}

export function shouldAcceptClaudeLoginResult(input: {
    loginSucceeded: boolean;
    aborted: boolean;
    credentialExistedBefore: boolean;
    credentialExistsAfter: boolean;
}): boolean {
    return !input.aborted && (
        input.loginSucceeded
        || (!input.credentialExistedBefore && input.credentialExistsAfter)
    );
}

/**
 * Ensure node-pty's spawn-helper has execute permission on macOS/Linux.
 *
 * node-pty prebuild tarballs lose the +x bit when extracted by npm/yarn,
 * causing every pty.spawn() to fail with "posix_spawnp failed.".
 * This is a no-op on Windows (conpty doesn't use spawn-helper).
 */
function ensurePtySpawnHelper(): void {
    if (process.platform === 'win32') return;
    try {
        const ptyLib = dirname(require.resolve('node-pty'));
        const ptyRoot = join(ptyLib, '..');
        // Match node-pty loadNativeModule search order: build/Release, build/Debug, prebuilds/
        const candidates = [
            join(ptyRoot, 'build', 'Release', 'spawn-helper'),
            join(ptyRoot, 'build', 'Debug', 'spawn-helper'),
            join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
        ];
        for (const helper of candidates) {
            if (!existsSync(helper)) continue;
            try {
                accessSync(helper, fsConstants.X_OK);
            } catch {
                chmodSync(helper, 0o755);
                logger.debug(`[node-pty] Fixed spawn-helper execute permission: ${helper}`);
            }
        }
    } catch { /* best-effort */ }
}

/** Find the Claude CLI binary path. */
/** Locate a CLI binary by name using `where.exe` (Windows) or `which` (Unix). */
function findCliBinary(name: string): { path: string; needsShell: boolean } | null {
    const isWindows = process.platform === 'win32';
    try {
        const cmd = isWindows ? `where.exe ${name}` : `which ${name}`;
        const result = execSync(cmd, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000,
            windowsHide: true,
        }).trim();

        const matches = result.split('\n').map(p => p.trim()).filter(Boolean);
        if (isWindows) {
            const withExt = matches.find(p => /\.(exe|cmd|bat)$/i.test(p));
            const binPath = withExt || matches[0];
            if (binPath && existsSync(binPath)) {
                return { path: binPath, needsShell: /\.(cmd|bat)$/i.test(binPath) };
            }
        } else if (matches[0] && existsSync(matches[0])) {
            return { path: matches[0], needsShell: false };
        }
    } catch { /* not in PATH */ }
    return null;
}

/** Find Claude CLI, respecting CCS_CLAUDE_PATH override. */
function findClaudeCli(): { path: string; needsShell: boolean } | null {
    if (process.env.CCS_CLAUDE_PATH) {
        const ccsPath = process.env.CCS_CLAUDE_PATH;
        if (existsSync(ccsPath)) {
            const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(ccsPath);
            return { path: ccsPath, needsShell };
        }
    }
    return findCliBinary('claude');
}

/** Find Codex CLI. */
function findCodexCli(): { path: string; needsShell: boolean } | null {
    return findCliBinary('codex');
}

/**
 * Analyze PTY output from `codex login --device-auth` and decide what action to take.
 *
 * Device-code flow (codex 0.118+):
 * 1. Codex prints URL `https://auth.openai.com/codex/device` + one-time code (e.g. `EZVG-FFQFL`)
 * 2. User opens URL, signs in, pastes the code
 * 3. Codex polls the OAuth server, writes `auth.json` and exits with "Logged in"
 *
 * Legacy browser flow (without --device-auth) still matches the same URL regex and
 * falls through to `{ action: 'forward-url' }` without a code — kept for backward compat.
 */
export type CodexLoginAction =
    | { action: 'forward-url'; url: string; code?: string }
    | { action: 'success' }
    | { action: 'error'; message: string }
    | { action: 'discard' };

// Device codes are printed as "XXXX-XXXX" / "XXXX-XXXXX" in uppercase A-Z/0-9.
// Anchored between word boundaries to avoid matching hex-ish noise.
const CODEX_DEVICE_CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;

export function analyzeCodexPtyOutput(buffer: string): CodexLoginAction {
    const clean = stripTerminalOutput(buffer);

    // Detect OAuth URL. Use `clean` (which converts cursor-positioning escapes to newlines)
    // rather than the continuous variant: codex's device-auth URL is short enough that
    // line-wrapping is never an issue, and using `clean` prevents the URL from greedily
    // concatenating with the next TUI line (e.g. "...device2. Enter this one-time code").
    const urlMatch = clean.match(/https:\/\/[^\s]*(auth\.openai\.com|auth0\.openai\.com|accounts\.google\.com)[^\s]*/);
    if (urlMatch) {
        const url = urlMatch[0].replace(/>+$/, '');

        // Device-auth flow prints a one-time code below the URL. Only harvest the code
        // when the marker text "one-time code" (or "device code") is present, so we don't
        // accidentally grab unrelated uppercase tokens from the legacy flow.
        const isDeviceFlow = /one-time code|device code/i.test(clean) || /\/device\b/.test(url);
        if (isDeviceFlow) {
            const codeMatch = clean.match(CODEX_DEVICE_CODE_RE);
            if (codeMatch) {
                return { action: 'forward-url', url, code: codeMatch[0] };
            }
            // URL seen but code hasn't rendered yet — wait for more data.
            return { action: 'discard' };
        }

        return { action: 'forward-url', url };
    }

    // Detect success — codex outputs "Logged in" or "Successfully logged in" on completion
    if (/logged in/i.test(clean)) {
        return { action: 'success' };
    }

    // Detect fatal path/config errors (e.g., CODEX_HOME not found)
    if (clean.includes('does not exist') || clean.includes('Error loading configuration')) {
        return { action: 'error', message: clean.trim() };
    }

    return { action: 'discard' };
}

/** Minimal shape of a CCS config.yaml for the fields we read/write. */
interface CcsConfig {
    version?: number;
    accounts?: Record<string, {
        created?: string;
        last_used?: string | null;
        continuity_mode?: string;
        [key: string]: unknown;
    }>;
    [key: string]: unknown;
}

/**
 * Register a new account in CCS config.yaml (unified mode).
 * Uses js-yaml for reliable YAML round-tripping.
 */
/** Exported for testing. */
export function registerProfile(profileName: string): void {
    const ccsDir = getCcsDir();
    const configPath = join(ccsDir, 'config.yaml');

    let config: CcsConfig;
    if (existsSync(configPath)) {
        config = (yaml.load(readFileSync(configPath, 'utf-8')) as CcsConfig) ?? {};
    } else {
        mkdirSync(ccsDir, { recursive: true });
        config = { version: 8 };
    }

    if (!config.accounts) config.accounts = {};

    const existing = config.accounts[profileName];
    config.accounts[profileName] = {
        created: existing?.created ?? new Date().toISOString(),
        last_used: existing?.last_used ?? null,
        continuity_mode: existing?.continuity_mode ?? 'standard',
    };

    const content = yaml.dump(config, { indent: 2, lineWidth: -1, quotingType: '"' });
    const tmpPath = configPath + '.' + randomBytes(4).toString('hex') + '.tmp';
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, configPath);
    logger.debug(`[!login] Registered profile "${profileName}" in ${configPath}`);
}

/**
 * Read account names from CCS config.yaml using js-yaml.
 */
function readAccountNames(): string[] {
    const configPath = join(getCcsDir(), 'config.yaml');
    if (!existsSync(configPath)) return [];
    try {
        const config = yaml.load(readFileSync(configPath, 'utf-8')) as CcsConfig | null;
        if (!config?.accounts) return [];
        return Object.keys(config.accounts);
    } catch { return []; }
}


/**
 * Link shared directories from instance to ~/.ccs/shared/.
 * Replicates CCS SharedManager.linkSharedDirectories() behavior.
 *
 * On Windows: uses 'junction' for directories (no admin required),
 * falls back to recursive copy if symlink fails.
 */
function linkSharedDirectories(instancePath: string): void {
    const sharedDir = join(getCcsDir(), 'shared');
    const claudeDir = join(homedir(), '.claude');
    const isWindows = process.platform === 'win32';

    // Shared items must match CCS SharedManager.sharedItems
    const sharedItems: Array<{ name: string; type: 'directory' | 'file' }> = [
        { name: 'commands', type: 'directory' },
        { name: 'skills', type: 'directory' },
        { name: 'agents', type: 'directory' },
        { name: 'plugins', type: 'directory' },
        { name: 'settings.json', type: 'file' },
    ];

    // Ensure shared directories exist and mirror from ~/.claude/
    mkdirSync(sharedDir, { recursive: true });
    for (const item of sharedItems) {
        const sharedPath = join(sharedDir, item.name);
        const claudePath = join(claudeDir, item.name);

        if (!existsSync(sharedPath)) {
            if (item.type === 'directory') {
                // If ~/.claude/<item> exists, it becomes the shared source
                // Otherwise create empty directory
                mkdirSync(sharedPath, { recursive: true });
            } else if (existsSync(claudePath)) {
                copyFileSync(claudePath, sharedPath);
            } else {
                writeFileSync(sharedPath, '{}', 'utf-8');
            }
        }
    }

    // Create instance → shared links
    for (const item of sharedItems) {
        const linkPath = join(instancePath, item.name);
        const targetPath = join(sharedDir, item.name);

        // Remove existing file/directory/link
        if (existsSync(linkPath)) {
            try {
                const stat = statSync(linkPath);
                if (stat.isDirectory()) {
                    rmSync(linkPath, { recursive: true, force: true });
                } else {
                    rmSync(linkPath, { force: true });
                }
            } catch {
                // lstat may fail on broken symlinks — try unlinking directly
                try { rmSync(linkPath, { force: true }); } catch { /* ignore */ }
            }
        }

        if (item.type === 'directory') {
            linkDirectoryWithFallback(targetPath, linkPath, isWindows);
            logger.debug(`[!login] Linked ${item.name}: ${linkPath} → ${targetPath}`);
        } else {
            try {
                symlinkSync(targetPath, linkPath, 'file');
                logger.debug(`[!login] Linked ${item.name}: ${linkPath} → ${targetPath}`);
            } catch (err) {
                if (isWindows) {
                    copyFileSync(targetPath, linkPath);
                    logger.debug(`[!login] Copied ${item.name} (symlink failed): ${(err as Error).message}`);
                } else {
                    logger.debug(`[!login] Failed to link ${item.name}: ${(err as Error).message}`);
                }
            }
        }
    }
}

/** Recursively copy a directory. */
function copyDirectoryRecursive(src: string, dest: string): void {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
        const srcPath = join(src, entry);
        const destPath = join(dest, entry);
        if (statSync(srcPath).isDirectory()) {
            copyDirectoryRecursive(srcPath, destPath);
        } else {
            copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * Link instance/projects to the shared context group root. Merges any pre-existing
 * project data before replacing the directory with a symlink. Never deletes data
 * without merging first.
 */
function syncProjectContext(instancePath: string): void {
    const projectsPath = join(instancePath, 'projects');
    const isWindows = process.platform === 'win32';
    const instanceName = instancePath.split(/[\\/]/).pop() || 'unknown';

    // Link projects → ~/.ccs/shared/context-groups/default/projects
    const sharedProjectsPath = join(getCcsDir(), 'shared', 'context-groups', 'default', 'projects');
    mkdirSync(sharedProjectsPath, { recursive: true, mode: 0o700 });

    // Check current state of instance/projects
    let currentStat;
    try {
        currentStat = lstatSync(projectsPath);
    } catch {
        // Doesn't exist — create symlink directly
        linkDirectoryWithFallback(sharedProjectsPath, projectsPath, isWindows);
        logger.debug(`[!login] Linked projects (new): ${projectsPath} → ${sharedProjectsPath}`);
        return;
    }

    if (currentStat.isSymbolicLink()) {
        let resolvedCurrent: string;
        try {
            resolvedCurrent = realpathSync(projectsPath);
        } catch {
            rmSync(projectsPath, { force: true });
            linkDirectoryWithFallback(sharedProjectsPath, projectsPath, isWindows);
            logger.debug(`[!login] Replaced broken projects symlink`);
            return;
        }

        if (samePath(resolvedCurrent, sharedProjectsPath)) {
            logger.debug(`[!login] Projects symlink already correct`);
            return;
        }

        if (isSafeProjectsMergeSource(resolvedCurrent, instanceName)) {
            detachLegacyMemoryLinks(resolvedCurrent, instanceName);
            mergeProjectsDirectory(resolvedCurrent, sharedProjectsPath, instanceName);
        } else {
            logger.debug(`[!login] Skipping unsafe merge source: ${resolvedCurrent}`);
        }
        rmSync(projectsPath, { force: true });
        linkDirectoryWithFallback(sharedProjectsPath, projectsPath, isWindows);
        logger.debug(`[!login] Relinked projects: ${resolvedCurrent} → ${sharedProjectsPath}`);
        return;
    }

    if (currentStat.isDirectory()) {
        detachLegacyMemoryLinks(projectsPath, instanceName);
        mergeProjectsDirectory(projectsPath, sharedProjectsPath, instanceName);
        rmSync(projectsPath, { recursive: true, force: true });
        linkDirectoryWithFallback(sharedProjectsPath, projectsPath, isWindows);
        logger.debug(`[!login] Merged and linked projects directory → ${sharedProjectsPath}`);
        return;
    }

    rmSync(projectsPath, { force: true });
    linkDirectoryWithFallback(sharedProjectsPath, projectsPath, isWindows);
    logger.debug(`[!login] Replaced unexpected projects entry with symlink`);
}

/** Windows/macOS have case-insensitive FS; Linux is case-sensitive. */
const FS_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** Resolve a path and normalize case for cross-platform comparison. */
function normalizePath(p: string): string {
    const resolved = resolve(p);
    return FS_CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

/** Compare two paths for equality under the current FS case sensitivity. */
function samePath(a: string, b: string): boolean {
    return normalizePath(a) === normalizePath(b);
}

/**
 * Check if a path is within CCS-managed directories and therefore safe to
 * merge from. Prevents merging arbitrary directories that a user may have
 * manually symlinked into place.
 */
function isSafeProjectsMergeSource(sourcePath: string, instanceName: string): boolean {
    const ccsDir = getCcsDir();
    const normalizedSource = normalizePath(sourcePath);
    const sharedRoot = normalizePath(join(ccsDir, 'shared', 'context-groups'));
    if (normalizedSource.startsWith(sharedRoot)) return true;
    const instanceRoot = normalizePath(join(ccsDir, 'instances', instanceName, 'projects'));
    return normalizedSource.startsWith(instanceRoot);
}

/**
 * Walk projects/<proj>/memory and, if any of them are symlinks into
 * ~/.ccs/shared/memory, replace them with real directories containing a
 * copy of the linked content. Keeps legacy installs from silently sharing
 * memory state across accounts.
 */
function detachLegacyMemoryLinks(projectsPath: string, instanceName?: string): void {
    let entries;
    try {
        entries = readdirSync(projectsPath, { withFileTypes: true });
    } catch {
        return;
    }

    const sharedMemoryRoot = normalizePath(join(getCcsDir(), 'shared', 'memory'));

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const memoryPath = join(projectsPath, entry.name, 'memory');
        try {
            const memStat = lstatSync(memoryPath);
            if (!memStat.isSymbolicLink()) continue;

            const memTarget = readlinkSync(memoryPath);
            const originalTarget = resolve(dirname(memoryPath), memTarget);
            if (!normalizePath(originalTarget).startsWith(sharedMemoryRoot)) continue;

            rmSync(memoryPath, { force: true });
            mkdirSync(memoryPath, { recursive: true, mode: 0o700 });
            mergeProjectsDirectory(originalTarget, memoryPath, instanceName);
            logger.debug(`[!login] Detached legacy memory link: ${memoryPath}`);
        } catch {
            continue;
        }
    }
}

/**
 * Create a directory symlink, falling back to a Windows junction when
 * needed. On Windows, falls back to a recursive copy if the OS still
 * refuses (common on non-dev-mode accounts). On other platforms, symlink
 * failures propagate — we don't want to silently copy.
 */
function linkDirectoryWithFallback(target: string, linkPath: string, isWindows: boolean): void {
    try {
        const symlinkType = isWindows ? 'junction' : 'dir';
        const linkTarget = isWindows ? resolve(target) : target;
        symlinkSync(linkTarget, linkPath, symlinkType);
        return;
    } catch (err) {
        if (!isWindows) throw err;
        copyDirectoryRecursive(target, linkPath);
        logger.debug(`[!login] Copied projects (symlink failed): ${(err as Error).message}`);
    }
}

/**
 * Merge source projects directory into destination, preserving conflicts.
 *
 * - Files only in source → copied to dest
 * - Files identical in both → skipped
 * - Files differ → dest kept, source saved as `<name>.migrated-from-<instance>`
 *
 * No file is ever silently discarded.
 */
function mergeProjectsDirectory(src: string, dest: string, instanceName?: string): void {
    let entries;
    try {
        entries = readdirSync(src, { withFileTypes: true });
    } catch {
        return;
    }

    mkdirSync(dest, { recursive: true, mode: 0o700 });

    for (const entry of entries) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);

        if (entry.isSymbolicLink()) {
            logger.debug(`[!login] Skipping symlink during merge: ${srcPath}`);
            continue;
        }

        if (entry.isDirectory()) {
            mergeProjectsDirectory(srcPath, destPath, instanceName);
            continue;
        }

        if (!entry.isFile()) continue;

        let destStat;
        try {
            destStat = statSync(destPath);
        } catch {
            copyFileSync(srcPath, destPath);
            continue;
        }

        if (filesAreEqual(srcPath, destPath, destStat.size)) continue;

        const conflictPath = getConflictCopyPath(destPath, instanceName);
        copyFileSync(srcPath, conflictPath);
        logger.debug(`[!login] Conflict: saved ${srcPath} as ${conflictPath}`);
    }
}

/**
 * Compare two files by size then content in fixed-size chunks. Avoids
 * loading large files (e.g. multi-MB session.jsonl) fully into memory.
 */
function filesAreEqual(fileA: string, fileB: string, knownSizeB?: number): boolean {
    let fdA = -1;
    let fdB = -1;
    try {
        const statA = statSync(fileA);
        const sizeB = knownSizeB ?? statSync(fileB).size;
        if (statA.size !== sizeB) return false;
        if (statA.size === 0) return true;

        const CHUNK = 64 * 1024;
        const bufA = Buffer.allocUnsafe(CHUNK);
        const bufB = Buffer.allocUnsafe(CHUNK);
        fdA = openSync(fileA, 'r');
        fdB = openSync(fileB, 'r');
        let offset = 0;
        while (offset < statA.size) {
            const want = Math.min(CHUNK, statA.size - offset);
            const readA = readSync(fdA, bufA, 0, want, offset);
            const readB = readSync(fdB, bufB, 0, want, offset);
            if (readA !== readB) return false;
            if (bufA.compare(bufB, 0, readA, 0, readA) !== 0) return false;
            offset += readA;
        }
        return true;
    } catch {
        return false;
    } finally {
        if (fdA !== -1) { try { closeSync(fdA); } catch { /* ignore */ } }
        if (fdB !== -1) { try { closeSync(fdB); } catch { /* ignore */ } }
    }
}

/**
 * Build a non-destructive conflict copy path.
 * e.g., `session.jsonl.migrated-from-alice`, with sequence suffix if needed.
 */
function getConflictCopyPath(existingPath: string, instanceName?: string): string {
    const safeName = (instanceName || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const baseSuffix = `.migrated-from-${safeName}`;
    let candidate = `${existingPath}${baseSuffix}`;
    let seq = 1;
    while (existsSync(candidate)) {
        candidate = `${existingPath}${baseSuffix}-${seq}`;
        seq++;
    }
    return candidate;
}

/** Remove instance directory on failure. */
function cleanupInstance(instancePath: string): void {
    try {
        if (existsSync(instancePath)) {
            rmSync(instancePath, { recursive: true, force: true });
        }
    } catch (err) {
        logger.debug('[!login] Failed to cleanup instance:', err);
    }
}

/**
 * Strip environment variables that would confuse the spawned Claude CLI
 * into thinking it's running inside an existing session.
 */
function buildChildEnv(instancePath: string): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: instancePath };

    for (const key of Object.keys(env)) {
        if (key.startsWith('CLAUDE_') && key !== 'CLAUDE_CONFIG_DIR') {
            delete env[key];
        }
    }

    // Remove happy-cli / ambient provider variables
    delete env.HAPPY_SESSION_ID;
    delete env.HAPPY_SERVER_URL;
    for (const key of Object.keys(env)) {
        if (key.startsWith('ANTHROPIC_') || key.startsWith('OPENAI_')) {
            delete env[key];
        }
    }

    return env;
}

/**
 * Handle `!login <name>` — create a new CCS profile via interactive Claude login.
 *
 * Flow:
 * 1. Validate profile name, create instance directory
 * 2. Spawn `claude` with CLAUDE_CONFIG_DIR pointing to the instance
 * 3. Forward Claude's login prompt output to mobile (markdown code blocks for copyability)
 * 4. User pastes OAuth key on mobile → piped to Claude's stdin
 * 5. On successful login (.credentials.json appears), register profile
 */
export async function handleLoginBangCommand(
    args: string,
    ctx: BangCommandContext,
): Promise<BangCommandResult> {
    const codexReject = rejectCodexFlagInSession(args, ctx);
    if (codexReject) return codexReject;

    if (hasActiveInteractiveSession()) {
        return {
            message: '❌ 已有登录流程进行中\n\n发送 `!cancel` 取消当前流程',
            action: 'none',
        };
    }

    const parsed = parseLoginArgs(args, ctx.flavor);
    if (parsed.kind === 'error') {
        return { message: parsed.message, action: 'none' };
    }
    const { profileName, targetAgent } = parsed;

    if (!profileName) {
        const accounts = targetAgent === 'codex'
            ? readCodexProfiles().map(p => p.name)
            : readAccountNames();

        const messages: string[] = [targetAgent === 'codex' ? '📋 Codex 账户' : '📋 Claude 账户'];
        messages.push(SEPARATOR);
        if (accounts.length === 0) {
            messages.push('（暂无账户）');
        } else {
            for (const name of accounts) {
                messages.push(name);
            }
        }
        messages.push(SEPARATOR);
        if (targetAgent === 'codex') {
            messages.push('!login --codex <账户名> 登录 Codex');
        } else {
            messages.push('!login <账户名> 登录 Claude');
        }

        return { message: messages, action: 'none' };
    }

    if (targetAgent === 'codex') {
        return performCodexLogin(profileName, ctx);
    }

    // Find Claude CLI
    const claudeInfo = findClaudeCli();
    if (!claudeInfo) {
        return {
            message: '❌ 未找到 Claude CLI\n\n请先安装 Claude Code',
            action: 'none',
        };
    }

    // Create instance directory (track whether it existed for cleanup decisions)
    const instancePath = getInstancePath(profileName);
    const dirExistedBefore = existsSync(instancePath);
    const credentialPath = join(instancePath, '.credentials.json');
    const credentialExistedBefore = existsSync(credentialPath);
    try {
        mkdirSync(instancePath, { recursive: true });
    } catch (err) {
        return {
            message: `❌ 创建实例目录失败: ${(err as Error).message}`,
            action: 'none',
        };
    }

    // Pre-create .claude.json to:
    // 1. Mark onboarding as completed (skip theme selector TUI)
    // 2. Pre-approve workspace trust for cwd (skip "Accessing workspace" prompt)
    const claudeJsonPath = join(instancePath, '.claude.json');
    if (!existsSync(claudeJsonPath)) {
        const cwd = homedir().replace(/\\/g, '/');
        writeFileSync(claudeJsonPath, JSON.stringify({
            hasCompletedOnboarding: true,
            numStartups: 0,
            projects: {
                [cwd]: { hasTrustDialogAccepted: true },
            },
        }, null, 2), 'utf-8');
        logger.debug('[!login] Pre-created .claude.json with onboarding + workspace trust');
    }

    // Pre-create settings.json to skip onboarding TUI and inherit proxy/env config.
    // Without this, Claude shows a full-screen theme selector unusable on mobile,
    // and proxy settings from the current instance won't carry over.
    const settingsPath = join(instancePath, 'settings.json');
    if (!existsSync(settingsPath)) {
        const seedSettings: Record<string, unknown> = {};
        // Copy env section (proxy, timeouts, etc.) from the current instance's settings
        const currentConfigDir = process.env.CLAUDE_CONFIG_DIR;
        const sourceSettingsPath = currentConfigDir
            ? join(currentConfigDir, 'settings.json')
            : null;
        if (sourceSettingsPath && existsSync(sourceSettingsPath)) {
            try {
                const source = JSON.parse(readFileSync(sourceSettingsPath, 'utf-8'));
                if (source.env && typeof source.env === 'object') {
                    seedSettings.env = source.env;
                }
            } catch { /* ignore parse errors */ }
        }
        writeFileSync(settingsPath, JSON.stringify(seedSettings, null, 2), 'utf-8');
        logger.debug('[!login] Pre-created settings.json with env from current instance');
    }

    // Spawn Claude CLI in a pseudo-TTY so the interactive login prompt works
    ensurePtySpawnHelper();
    const childEnv = buildChildEnv(instancePath);
    // node-pty needs a clean env record (no undefined values)
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(childEnv)) {
        if (v !== undefined) cleanEnv[k] = v;
    }

    let ptyProcess: pty.IPty;
    try {
        const shell = process.platform === 'win32' && claudeInfo.needsShell;
        ptyProcess = pty.spawn(
            shell ? process.env.COMSPEC || 'cmd.exe' : claudeInfo.path,
            shell ? ['/c', claudeInfo.path] : [],
            {
                name: 'xterm-256color',
                cols: 1000, // Wide enough to prevent PTY line-wrapping mid-URL (OAuth URLs ~400 chars)
                rows: 30,
                cwd: homedir(), // Use home dir — no project = no workspace trust prompt
                env: cleanEnv,
            },
        );
    } catch (err) {
        if (!dirExistedBefore) cleanupInstance(instancePath);
        return {
            message: `❌ 启动 Claude 失败: ${(err as Error).message}`,
            action: 'none',
        };
    }

    // Output buffering — debounce PTY chunks into meaningful messages
    let outputBuffer = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let exited = false;

    const flushOutput = (): void => {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        const text = stripTerminalOutput(outputBuffer).trim();
        outputBuffer = '';
        if (text) {
            // Use sendAgentTextMessage for markdown rendering (code block with copy button)
            ctx.client.sendCodexMessage({ type: 'message', message: codeBlock(text) });
        }
    };

    let loginUrlSent = false;
    let loginCommandSent = false;
    let loginSucceeded = false;
    let aborted = false;
    let terminalNoticeSent = false;
    let preAuthDeadline: { clear(): void } | null = null;

    const clearPreAuthDeadline = (): void => {
        preAuthDeadline?.clear();
        preAuthDeadline = null;
    };

    const finishTerminalFailure = (message: string, flushBufferedOutput: boolean): void => {
        if (terminalNoticeSent || exited) return;
        aborted = true;
        terminalNoticeSent = true;
        clearPreAuthDeadline();
        unregisterInteractiveSession();
        if (flushBufferedOutput) {
            flushOutput();
        } else {
            if (flushTimer) clearTimeout(flushTimer);
            flushTimer = null;
            outputBuffer = '';
        }
        try { ptyProcess.kill(); } catch (err) {
            logger.debug('[!login] Failed to terminate Claude PTY:', err);
        }
        if (!dirExistedBefore) cleanupInstance(instancePath);
        ctx.client.sendCodexMessage({ type: 'message', message });
        ctx.client.sendSessionEvent({ type: 'ready' });
    };

    ptyProcess.onData((data: string) => {
        if (loginSucceeded || aborted) return; // Already finishing — ignore residual PTY output
        outputBuffer += data;

        const result = analyzePtyOutput(outputBuffer, loginUrlSent, loginCommandSent);
        logger.debug(`[!login] onData action=${result.action} bufLen=${outputBuffer.length} stripped="${stripTerminalOutput(outputBuffer).slice(0, 200)}"`);

        switch (result.action) {
            case 'auto-respond':
                logger.debug(`[!login] Auto-responding: ${result.response.trim()}`);
                if (result.response === '/login\r') loginCommandSent = true;
                outputBuffer = '';
                if (flushTimer) clearTimeout(flushTimer);
                ptyProcess.write(result.response);
                return;

            case 'forward-url':
                loginUrlSent = true;
                clearPreAuthDeadline();
                logger.debug(`[!login] OAuth URL detected: ${result.url}`);
                outputBuffer = '';
                if (flushTimer) clearTimeout(flushTimer);

                ctx.client.sendCodexMessage({ type: 'message', message:
                    '🔗 请在浏览器中打开以下链接登录:\n\n' + codeBlock(result.url) + '\n\n登录后将 OAuth Key 粘贴到下方发送'
                });
                return;

            case 'already-authenticated':
                // Claude found existing credentials (keychain), but user asked to login —
                // always force OAuth flow so they authenticate with the intended account.
                logger.debug('[!login] Already authenticated — forcing /login for fresh credentials');
                outputBuffer = '';
                if (flushTimer) clearTimeout(flushTimer);
                loginCommandSent = true; // Prevent re-triggering "Welcome back" detection
                ptyProcess.write('/login\r');
                return;

            case 'discard':
                // Keep accumulating — don't clear buffer during phase 1.
                // The buffer grows until we match a URL or an auto-respond prompt.
                return;

            case 'forward': {
                const forwardText = stripAnsiOnly(outputBuffer);

                // Detect "Login successful" → auto-send Enter, then kill process
                if (forwardText.includes('Login successful')) {
                    logger.debug('[!login] Login successful detected, sending Enter and finishing');
                    loginSucceeded = true;
                    clearPreAuthDeadline();
                    outputBuffer = '';
                    if (flushTimer) clearTimeout(flushTimer);
                    ptyProcess.write('\r');
                    // Give Claude a moment to save credentials, then kill
                    setTimeout(() => { try { ptyProcess.kill(); } catch {} }, 2000);
                    return;
                }

                // Detect OAuth error (invalid code) → kill process and notify user
                if (forwardText.includes('OAuth error') || forwardText.includes('Invalid code')) {
                    logger.debug('[!login] OAuth error detected, terminating login session');
                    finishTerminalFailure('❌ 登录失败: 无效的 OAuth Code\n\n请重新使用 !login 登录', false);
                    return;
                }

                if (flushTimer) clearTimeout(flushTimer);
                flushTimer = setTimeout(flushOutput, 300);
                return;
            }
        }
    });

    // Register interactive input handler
    registerInteractiveSession((text: string) => {
        const trimmed = text.trim();

        if (trimmed === '!cancel' || trimmed === '!取消') {
            logger.debug('[!login] User cancelled login');
            finishTerminalFailure('❌ 登录已取消', true);
            return;
        }

        if (exited) {
            logger.debug('[!login] Process already exited, ignoring input');
            return;
        }

        logger.debug('[!login] Feeding input to Claude PTY');
        // Claude Code's OAuth code input is a password/paste-aware field — writing
        // `text + '\r'` in one chunk causes the trailing `\r` to be swallowed as
        // part of the pasted payload, so submit never fires. Write the body, let
        // Claude's paste buffer flush, then send `\r` as an independent keystroke.
        try {
            const body = text.replace(/[\r\n]+$/, '');
            ptyProcess.write(body);
            setTimeout(() => {
                try { ptyProcess.write('\r'); } catch (err) {
                    logger.debug('[!login] Failed to send submit CR:', err);
                }
            }, 120);
        } catch (err) {
            logger.debug('[!login] Failed to write to PTY:', err);
        }
    });

    // Handle process exit
    ptyProcess.onExit(({ exitCode }) => {
        exited = true;
        clearPreAuthDeadline();
        unregisterInteractiveSession();
        if (terminalNoticeSent) return;
        flushOutput();

        // Only trust explicit PTY success signals or newly written credential files.
        // Do NOT check keychain here — it may contain old tokens from before this login attempt.
        const hasCredentials = shouldAcceptClaudeLoginResult({
            loginSucceeded,
            aborted,
            credentialExistedBefore,
            credentialExistsAfter: existsSync(credentialPath),
        });

        if (hasCredentials) {
            try {
                registerProfile(profileName);
                linkSharedDirectories(instancePath);
                syncProjectContext(instancePath);
                const msg = `✅ 配置 "${profileName}" 登录成功\n\n`
                    + `切换账号: !auth ${profileName}`;
                ctx.client.sendCodexMessage({ type: 'message', message: msg });
            } catch (err) {
                logger.debug('[!login] Failed to register profile:', err);
                ctx.client.sendCodexMessage({ type: 'message', message: `⚠️ 登录成功但注册失败: ${(err as Error).message}` });
            }
        } else {
            if (!dirExistedBefore) cleanupInstance(instancePath);
            logger.debug(`[!login] Login failed with exit code: ${exitCode ?? 'unknown'}`);
            ctx.client.sendCodexMessage({ type: 'message', message: `❌ 登录失败或已取消\n\n重新尝试: !login ${profileName}` });
        }

        ctx.client.sendSessionEvent({ type: 'ready' });
    });

    preAuthDeadline = createClaudeLoginPreAuthDeadline(() => {
        finishTerminalFailure(
            `❌ 登录启动超时\n\n重新尝试: !login ${profileName}`,
            false,
        );
    });

    // Return immediately — the interactive session runs asynchronously
    const msg = `🔐 正在登录...\n\n`
        + `配置: ${profileName}\n\n`
        + '请等待登录提示，然后粘贴 OAuth Key\n\n'
        + '取消: !cancel';
    return { message: msg, action: 'none' };
}

// ---------------------------------------------------------------------------
// Codex shared-directory linking (mirrors linkSharedDirectories for Claude)
// ---------------------------------------------------------------------------

/**
 * Get the base directory for shared Codex resources across profiles.
 * Layout: <happyHomeDir>/auth/codex/shared/
 */
function getCodexSharedDir(): string {
    return join(getHappyHome(), 'auth', 'codex', 'shared');
}

/**
 * Link shared directories from a Codex instance to ~/.happy/auth/codex/shared/.
 * Replicates the CCS SharedManager.linkSharedDirectories() pattern for
 * Codex instances, ensuring config and skills stay in sync across profiles
 * within the same shared context group.
 *
 * Shared items:
 * - config.toml — proxy/trust settings (all profiles should use the same proxy)
 * - .env — environment variables (proxy, custom vars)
 * - skills/ — user-defined Codex skills
 *
 * NOT shared (per-instance):
 * - auth.json, sessions/, history.jsonl, state_*.sqlite, logs_*.sqlite,
 *   cap_sid, .sandbox*, models_cache.json, version.json
 *
 * On Windows: uses junction for directories and falls back to copy if symlink
 * fails (mirrors linkSharedDirectories behaviour).
 */
function linkCodexSharedDirectories(codexInstancePath: string): void {
    const sharedDir = getCodexSharedDir();
    const isWindows = process.platform === 'win32';

    const sharedItems: Array<{ name: string; type: 'directory' | 'file' }> = [
        { name: 'skills', type: 'directory' },
        { name: 'prompts', type: 'directory' },
        { name: 'config.toml', type: 'file' },
        { name: '.env', type: 'file' },
    ];

    // Ensure shared directory exists.
    // Seed initial content from the instance being linked (first profile wins).
    mkdirSync(sharedDir, { recursive: true });
    for (const item of sharedItems) {
        const sharedPath = join(sharedDir, item.name);
        const instanceSource = join(codexInstancePath, item.name);

        if (!existsSync(sharedPath)) {
            if (item.type === 'directory') {
                if (existsSync(instanceSource) && statSync(instanceSource).isDirectory()) {
                    copyDirectoryRecursive(instanceSource, sharedPath);
                } else {
                    mkdirSync(sharedPath, { recursive: true });
                }
            } else if (existsSync(instanceSource)) {
                copyFileSync(instanceSource, sharedPath);
            }
            // If neither shared nor instance copy exists, skip — don't create empty files
        }
    }

    // Create instance → shared links (replacing existing files/directories)
    for (const item of sharedItems) {
        const linkPath = join(codexInstancePath, item.name);
        const targetPath = join(sharedDir, item.name);

        // Only create a link when the shared target exists
        if (!existsSync(targetPath)) continue;

        // Remove whatever currently sits at the link path
        try {
            const st = lstatSync(linkPath);
            if (st.isSymbolicLink() || !st.isDirectory()) {
                rmSync(linkPath, { force: true });
            } else {
                rmSync(linkPath, { recursive: true, force: true });
            }
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                try { rmSync(linkPath, { force: true }); } catch { /* ignore */ }
            }
        }

        if (item.type === 'directory') {
            linkDirectoryWithFallback(targetPath, linkPath, isWindows);
            logger.debug(`[!login:codex] Linked ${item.name}: ${linkPath} → ${targetPath}`);
        } else {
            try {
                symlinkSync(targetPath, linkPath, 'file');
                logger.debug(`[!login:codex] Linked ${item.name}: ${linkPath} → ${targetPath}`);
            } catch (err) {
                if (isWindows) {
                    // Windows file symlinks need developer-mode; fall back to copy
                    copyFileSync(targetPath, linkPath);
                    logger.debug(`[!login:codex] Copied ${item.name} (symlink failed): ${(err as Error).message}`);
                } else {
                    logger.debug(`[!login:codex] Failed to link ${item.name}: ${(err as Error).message}`);
                }
            }
        }
    }
}

/**
 * Link a Codex instance's session history into the shared cross-profile directory.
 *
 * Codex sessions are date-layered JSONL files with unique UUIDs in the filename
 * (e.g. sessions/2026/04/10/rollout-2026-04-10T11-05-43-<UUID>.jsonl), so
 * merging into a shared directory is safe — no naming collisions.
 *
 * Shared layout:
 *   ~/.happy/auth/codex/shared/context-groups/default/sessions/   (symlinked)
 *   ~/.happy/auth/codex/shared/context-groups/default/history.jsonl (symlinked)
 *
 * state_*.sqlite is intentionally NOT shared — it is a rebuildable index and
 * sharing it would cause SQLite lock contention across concurrent profiles.
 */
function syncCodexSessionSharing(codexInstancePath: string): void {
    const isWindows = process.platform === 'win32';

    // Link sessions → shared default context-group directory
    const sharedGroupDir = join(getCodexSharedDir(), 'context-groups', 'default');
    const sharedSessionsPath = join(sharedGroupDir, 'sessions');
    const sharedHistoryPath = join(sharedGroupDir, 'history.jsonl');
    mkdirSync(sharedSessionsPath, { recursive: true });

    // --- sessions/ ---
    const instanceSessions = join(codexInstancePath, 'sessions');
    try {
        const st = lstatSync(instanceSessions);
        if (st.isSymbolicLink()) {
            // Already a symlink — verify it points to the correct target
            let resolved: string;
            try { resolved = realpathSync(instanceSessions); } catch {
                rmSync(instanceSessions, { force: true });
                linkDirectoryWithFallback(sharedSessionsPath, instanceSessions, isWindows);
                logger.debug('[!login:codex] Replaced broken sessions symlink');
                return;
            }
            if (samePath(resolved, sharedSessionsPath)) {
                logger.debug('[!login:codex] Sessions symlink already correct');
            } else {
                // Pointing to a different group — merge and relink
                mergeSessionsDirectory(resolved, sharedSessionsPath);
                rmSync(instanceSessions, { force: true });
                linkDirectoryWithFallback(sharedSessionsPath, instanceSessions, isWindows);
                logger.debug(`[!login:codex] Relinked sessions: ${resolved} → ${sharedSessionsPath}`);
            }
        } else if (st.isDirectory()) {
            // Plain directory with existing sessions — merge into shared, then link
            mergeSessionsDirectory(instanceSessions, sharedSessionsPath);
            rmSync(instanceSessions, { recursive: true, force: true });
            linkDirectoryWithFallback(sharedSessionsPath, instanceSessions, isWindows);
            logger.debug(`[!login:codex] Merged and linked sessions → ${sharedSessionsPath}`);
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            linkDirectoryWithFallback(sharedSessionsPath, instanceSessions, isWindows);
            logger.debug(`[!login:codex] Linked sessions (new) → ${sharedSessionsPath}`);
        }
    }

    // --- history.jsonl ---
    const instanceHistory = join(codexInstancePath, 'history.jsonl');
    // Seed shared history from instance if it exists and shared doesn't
    if (!existsSync(sharedHistoryPath)) {
        if (existsSync(instanceHistory)) {
            try {
                const st = lstatSync(instanceHistory);
                if (!st.isSymbolicLink()) {
                    copyFileSync(instanceHistory, sharedHistoryPath);
                    logger.debug('[!login:codex] Seeded shared history.jsonl from instance');
                }
            } catch (err) {
                logger.debug(`[!login:codex] Failed to seed history: ${(err as Error).message}`);
            }
        }
    } else if (existsSync(instanceHistory)) {
        // Both exist — append instance entries not already in shared
        try {
            const st = lstatSync(instanceHistory);
            if (!st.isSymbolicLink()) {
                const instanceContent = readFileSync(instanceHistory, 'utf-8').trim();
                const sharedContent = readFileSync(sharedHistoryPath, 'utf-8').trim();
                if (instanceContent && instanceContent !== sharedContent) {
                    const sharedLines = new Set(sharedContent.split('\n').filter(Boolean));
                    const newLines = instanceContent.split('\n').filter(l => l && !sharedLines.has(l));
                    if (newLines.length > 0) {
                        writeFileSync(sharedHistoryPath, sharedContent + '\n' + newLines.join('\n') + '\n', 'utf-8');
                        logger.debug(`[!login:codex] Merged ${newLines.length} history entries`);
                    }
                }
            }
        } catch (err) {
            logger.debug(`[!login:codex] History merge failed: ${(err as Error).message}`);
        }
    }

    // Replace instance history with symlink
    try {
        const st = lstatSync(instanceHistory);
        if (!st.isSymbolicLink()) rmSync(instanceHistory, { force: true });
        else if (samePath(realpathSync(instanceHistory), sharedHistoryPath)) return; // already correct
        else rmSync(instanceHistory, { force: true });
    } catch { /* doesn't exist yet — fine */ }

    if (existsSync(sharedHistoryPath)) {
        try {
            symlinkSync(sharedHistoryPath, instanceHistory, 'file');
            logger.debug(`[!login:codex] Linked history.jsonl → ${sharedHistoryPath}`);
        } catch (err) {
            if (isWindows) {
                try { copyFileSync(sharedHistoryPath, instanceHistory); } catch { /* ignore */ }
                logger.debug(`[!login:codex] Copied history.jsonl (symlink failed): ${(err as Error).message}`);
            }
        }
    }
}

/**
 * Recursively merge Codex session files from src into dest.
 * Sessions use unique UUID filenames, so conflicts are extremely unlikely.
 * If a file already exists in dest, it is skipped (not overwritten).
 */
function mergeSessionsDirectory(src: string, dest: string): void {
    let entries;
    try { entries = readdirSync(src, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);

        if (entry.isDirectory()) {
            mkdirSync(destPath, { recursive: true });
            mergeSessionsDirectory(srcPath, destPath);
        } else if (!existsSync(destPath)) {
            try {
                copyFileSync(srcPath, destPath);
            } catch (err) {
                logger.debug(`[!login:codex] Failed to merge session ${entry.name}: ${(err as Error).message}`);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Codex-specific login flow
// ---------------------------------------------------------------------------

/**
 * Handle `!login <name>` for Codex backend.
 *
 * Flow (device-auth mode, codex-cli 0.118+):
 * 1. Create codex instance directory (~/.happy/auth/codex/instances/<name>/)
 * 2. Copy config.toml + .env from current CODEX_HOME (if available)
 * 3. Spawn `codex login --device-auth` with CODEX_HOME pointing to the new instance
 * 4. Detect OAuth URL + one-time code from output → forward both to mobile
 * 5. User signs in via browser, pastes the code; codex polls the OAuth server
 * 6. Codex writes auth.json and prints "Logged in" → PTY exits
 * 7. On exit: check auth.json → register CCS profile + success message
 *
 * Device-auth requires the user to have enabled "Device code authorization" in their
 * ChatGPT security settings (personal) or workspace admin panel (team). If disabled,
 * codex falls back to the legacy localhost:1455 browser callback — that path is
 * currently unreachable in headless/remote environments and will hang. We surface a
 * hint in the mobile message so the user knows where to enable it.
 */
type AcquireCodexLoginLockResult =
    | { kind: 'acquired'; started: string }
    | { kind: 'busy' }
    | { kind: 'error'; error: Error };

/**
 * Atomically acquire the codex login lock in `phase='started'` using O_EXCL
 * (Node `flag: 'wx'`). The lock has a two-phase lifecycle:
 *
 *   1. acquireCodexLoginLock          → phase='started'   (no fs side effects yet)
 *   2. updateCodexLoginLockToSpawned  → phase='spawned'   (right before spawning codex)
 *   3. release (rmSync lockPath)      → fully cleaned
 *
 * Recovery uses the phase to disambiguate two crash scenarios:
 *   - phase='started' → codex never ran; defaultAuthPath is untouched
 *   - phase='spawned' → codex may have written; restore from backup or delete leftover
 *
 * This two-phase design eliminates the family of races where partial fs effects
 * (mkdir, seed, backup) were observable to concurrent processes BEFORE the lock was
 * held. With this scheme, the lock is the very first observable side effect on
 * ~/.codex; everything else happens strictly inside the lock-protected window.
 *
 * Exposed at module scope so unit tests can exercise the busy/error paths without
 * spawning a real PTY / OAuth flow.
 */
export function acquireCodexLoginLock(
    lockPath: string,
    info: { profileName: string },
): AcquireCodexLoginLockResult {
    const started = new Date().toISOString();
    try {
        writeFileSync(
            lockPath,
            JSON.stringify({
                profileName: info.profileName,
                pid: process.pid,
                started,
                phase: 'started',
                hadOriginal: false,
            }),
            { flag: 'wx', encoding: 'utf-8' },
        );
        return { kind: 'acquired', started };
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') return { kind: 'busy' };
        return { kind: 'error', error: err as Error };
    }
}

/**
 * Transition an already-held lock from phase='started' to phase='spawned'. Caller
 * must hold the lock (i.e., have acquired via acquireCodexLoginLock and not released).
 *
 * Uses `flag: 'w'` (overwrite) since the caller owns the lock — atomic creation is
 * unnecessary. Throws if the underlying writeFileSync fails so the caller can
 * roll back backup + release lock.
 */
export function updateCodexLoginLockToSpawned(
    lockPath: string,
    info: { profileName: string; started: string; hadOriginal: boolean },
): void {
    writeFileSync(
        lockPath,
        JSON.stringify({
            profileName: info.profileName,
            pid: process.pid,
            started: info.started,
            phase: 'spawned',
            hadOriginal: info.hadOriginal,
        }),
        { flag: 'w', encoding: 'utf-8' },
    );
}

function performCodexLogin(
    profileName: string,
    ctx: BangCommandContext,
): BangCommandResult {
    const codexInfo = findCodexCli();
    if (!codexInfo) {
        return {
            message: '❌ 未找到 Codex CLI\n\n请先安装: npm install -g @openai/codex',
            action: 'none',
        };
    }

    // Concurrency invariant: every observable fs side effect on ~/.codex (mkdir
    // instance, seed config, backup auth.json, spawn codex, finalize) must run
    // inside the lock-protected window. The atomic O_EXCL acquire (acquireCodexLoginLock
    // below) is the EVENT HORIZON — a concurrent happy process is blocked there and
    // cannot observe any partial state.
    //
    // The lock has two phases (phase='started' → phase='spawned'). Crash recovery
    // uses the phase to decide whether codex may have touched ~/.codex/auth.json:
    //   - phase='started' → codex never ran; defaultAuthPath is the user's original
    //   - phase='spawned' → restore from backup (or delete leftover) per hadOriginal
    const defaultCodexHome = join(homedir(), '.codex');
    const defaultAuthPath = join(defaultCodexHome, 'auth.json');
    const lockPath = join(defaultCodexHome, '.happy-login.lock');
    const backupAuthPath = join(defaultCodexHome, 'auth.json.happy-bak');

    const codexInstancePath = getCodexInstancePath(profileName);
    const dirExistedBefore = existsSync(codexInstancePath);

    // Idempotent: ensure ~/.codex exists so we have somewhere to put the lock file.
    // mkdir recursive produces no observable mid-state, so it's safe outside the lock.
    try {
        mkdirSync(defaultCodexHome, { recursive: true });
    } catch (err) {
        return {
            message: `❌ 创建 ~/.codex 失败: ${(err as Error).message}`,
            action: 'none',
        };
    }

    logger.info(`[!login:codex] BEGIN profile=${profileName} defaultCodexHome=${defaultCodexHome} instancePath=${codexInstancePath} dirExistedBefore=${dirExistedBefore}`);

    // -------- ATOMIC LOCK ACQUISITION (event horizon) --------
    // Up to this point we have NOT made any observable side effect on ~/.codex.
    // After this point, every fs op is fully serialized by the lock — no other happy
    // process can interleave. busy/error returns immediately with no cleanup needed.
    const lockResult = acquireCodexLoginLock(lockPath, { profileName });
    if (lockResult.kind === 'busy') {
        logger.warn(`[!login:codex] acquireLock=busy lockPath=${lockPath} — another login in flight, refusing`);
        return {
            message: '❌ 另一个 Codex 登录正在进行中\n\n请等待它完成；若进程已退出可重启 happy 自动清理',
            action: 'none',
        };
    }
    if (lockResult.kind === 'error') {
        logger.warn(`[!login:codex] acquireLock=error code=${(lockResult.error as NodeJS.ErrnoException).code ?? 'unknown'} message=${lockResult.error.message}`);
        return {
            message: `❌ 创建登录锁失败: ${lockResult.error.message}`,
            action: 'none',
        };
    }
    const lockStarted = lockResult.started;
    logger.info(`[!login:codex] acquireLock=acquired phase=started started=${lockStarted}`);

    // ============== UNDER LOCK ==============
    // closure variables consumed by restoreDefaultAuth and the onExit finalize block.
    // hadOriginal replaces the old `backedUp` flag — same semantics, clearer name.
    let hadOriginal = false;
    const releaseLock = (): void => {
        try { rmSync(lockPath, { force: true }); } catch {}
    };
    const restoreDefaultAuth = (): void => {
        try {
            if (hadOriginal && existsSync(backupAuthPath)) {
                copyFileSync(backupAuthPath, defaultAuthPath);
            } else if (!hadOriginal) {
                rmSync(defaultAuthPath, { force: true });
            }
        } catch (err) {
            logger.warn('[!login:codex] restore default auth failed', err);
        }
        try { rmSync(backupAuthPath, { force: true }); } catch {}
    };

    // 1. Create the per-profile instance dir (now under lock, so concurrent !login
    //    on the same machine is fully serialized regardless of profile name).
    try {
        mkdirSync(codexInstancePath, { recursive: true });
    } catch (err) {
        releaseLock();
        return {
            message: `❌ 创建实例目录失败: ${(err as Error).message}`,
            action: 'none',
        };
    }

    // 2. Seed instance config.toml/.env from current CODEX_HOME — first profile's
    //    instance promotes these into the shared dir via linkCodexSharedDirectories
    //    below, so users who configured proxy/trust in ~/.codex carry it across all
    //    happy-managed profiles.
    const currentCodexHome = process.env.CODEX_HOME || defaultCodexHome;
    const seedReport: Record<string, string> = {};
    for (const file of ['config.toml', '.env'] as const) {
        const destFile = join(codexInstancePath, file);
        if (existsSync(destFile)) {
            seedReport[file] = 'skipped (dest exists)';
            continue;
        }
        const srcFile = join(currentCodexHome, file);
        if (!existsSync(srcFile)) {
            seedReport[file] = 'no source';
            continue;
        }
        try {
            copyFileSync(srcFile, destFile);
            seedReport[file] = `copied from ${srcFile}`;
        } catch (err) {
            seedReport[file] = `copy failed: ${(err as Error).message}`;
        }
    }
    logger.info(`[!login:codex] seed config (currentCodexHome=${currentCodexHome}): ${JSON.stringify(seedReport)}`);

    // 3. Backup ~/.codex/auth.json if it exists — now safe under lock, no concurrent
    //    process can race against the shared backup file because they're all blocked
    //    at acquireCodexLoginLock.
    if (existsSync(defaultAuthPath)) {
        try {
            const stats = statSync(defaultAuthPath);
            copyFileSync(defaultAuthPath, backupAuthPath);
            hadOriginal = true;
            logger.info(`[!login:codex] backup defaultAuth: size=${stats.size} mtime=${stats.mtime.toISOString()} → ${backupAuthPath}`);
        } catch (err) {
            logger.warn(`[!login:codex] backup defaultAuth failed: ${(err as Error).message}`);
            releaseLock();
            if (!dirExistedBefore) cleanupInstance(codexInstancePath);
            return {
                message: `❌ 备份 ~/.codex/auth.json 失败: ${(err as Error).message}`,
                action: 'none',
            };
        }
    } else {
        logger.info(`[!login:codex] no defaultAuth at ${defaultAuthPath}, hadOriginal=false`);
    }

    // 4. Transition lock to phase='spawned'. From this point on, recovery treats
    //    defaultAuthPath as "potentially modified by codex" and will restore from
    //    backup (or delete leftover) according to hadOriginal.
    try {
        updateCodexLoginLockToSpawned(lockPath, {
            profileName,
            started: lockStarted,
            hadOriginal,
        });
        logger.info(`[!login:codex] lock transition: phase=started → phase=spawned hadOriginal=${hadOriginal}`);
    } catch (err) {
        logger.warn(`[!login:codex] updateLockToSpawned failed: ${(err as Error).message}`);
        restoreDefaultAuth();
        releaseLock();
        if (!dirExistedBefore) cleanupInstance(codexInstancePath);
        return {
            message: `❌ 更新登录锁失败: ${(err as Error).message}`,
            action: 'none',
        };
    }

    // 5. Build env for codex login — DO NOT override CODEX_HOME (let codex use ~/.codex).
    // Delegates dotenv proxy inject + upper↔lower mirror + diagnostic snapshot to the
    // shared builder so the spec stays in lockstep with runCodexAppServer. The helper
    // emits its own snapshot log line under the same tag.
    const { env: childEnv } = buildCodexChildEnv({
        baseEnv: process.env,
        dotenvPath: join(defaultCodexHome, '.env'),
        keysToDelete: ['CODEX_HOME', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
        logTag: '!login:codex',
    });
    logger.info(`[!login:codex] CODEX_HOME explicitly: ${childEnv.CODEX_HOME ?? '<unset>'} (deleted from inherited env, codex will fall back to ~/.codex)`);
    logger.info(`[!login:codex] spawn target: path=${codexInfo.path} needsShell=${codexInfo.needsShell} cwd=${homedir()}`);

    // Spawn codex login via PTY
    ensurePtySpawnHelper();
    let ptyProcess: pty.IPty;
    try {
        const shell = process.platform === 'win32' && codexInfo.needsShell;
        ptyProcess = pty.spawn(
            shell ? process.env.COMSPEC || 'cmd.exe' : codexInfo.path,
            shell
                ? ['/c', codexInfo.path, 'login', '--device-auth']
                : ['login', '--device-auth'],
            {
                name: 'xterm-256color',
                cols: 1000,
                rows: 30,
                cwd: homedir(),
                env: childEnv,
            },
        );
    } catch (err) {
        restoreDefaultAuth();
        releaseLock();
        if (!dirExistedBefore) cleanupInstance(codexInstancePath);
        return {
            message: `❌ 启动 Codex 登录失败: ${(err as Error).message}`,
            action: 'none',
        };
    }

    let outputBuffer = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let exited = false;
    let loginSucceeded = false;
    // State for failure / cancel paths — set by error/cancel handlers, consumed by
    // onExit so the mobile message is dispatched AFTER finalize completes (single
    // source of truth, no double-message races).
    let cancelled = false;
    let errorMessage: string | null = null;
    // Reentrancy guard for onExit — node-pty has been observed double-firing onExit
    // on Windows ConPTY in rare error paths. Without this guard, finalize would
    // re-migrate (potentially with the restored backup as source) and double-dispatch
    // the mobile message.
    let finalized = false;
    // Ring buffer of the last ~4KB of raw PTY output — survives discard/flush so
    // onExit can dump the final codex stderr/stdout when login fails.
    let recentOutput = '';

    const flushOutput = (): void => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        const text = stripTerminalOutput(outputBuffer).trim();
        outputBuffer = '';
        if (text) {
            ctx.client.sendCodexMessage({ type: 'message', message: codeBlock(text) });
        }
    };

    ptyProcess.onData((data: string) => {
        if (loginSucceeded) return;
        outputBuffer += data;
        recentOutput = (recentOutput + data).slice(-4096);

        const result = analyzeCodexPtyOutput(outputBuffer);
        logger.info(`[!login:codex] onData action=${result.action} bufLen=${outputBuffer.length} stripped=${JSON.stringify(stripTerminalOutput(outputBuffer).slice(0, 300))}`);

        switch (result.action) {
            case 'forward-url':
                outputBuffer = '';
                if (flushTimer) clearTimeout(flushTimer);
                {
                    const lines: string[] = [];
                    if (result.code) {
                        lines.push('🔗 请在浏览器中打开以下链接登录 Codex:');
                        lines.push('');
                        lines.push(codeBlock(result.url));
                        lines.push('');
                        lines.push('🔢 然后在页面上输入一次性 code（15 分钟内有效）:');
                        lines.push('');
                        lines.push(codeBlock(result.code));
                        lines.push('');
                        lines.push('> 如果页面提示找不到 code 输入框，请先在 ChatGPT 账号的 Security settings 里启用 "Device code authorization"。');
                        lines.push('');
                        lines.push('登录完成后将自动检测');
                    } else {
                        lines.push('🔗 请在浏览器中打开以下链接登录 Codex:');
                        lines.push('');
                        lines.push(codeBlock(result.url));
                        lines.push('');
                        lines.push('登录完成后将自动检测');
                    }
                    ctx.client.sendCodexMessage({ type: 'message', message: lines.join('\n') });
                }
                return;

            case 'success':
                loginSucceeded = true;
                outputBuffer = '';
                if (flushTimer) clearTimeout(flushTimer);
                logger.debug('[!login:codex] Login success detected');
                setTimeout(() => { try { ptyProcess.kill(); } catch {} }, 1000);
                return;

            case 'error':
                outputBuffer = '';
                if (flushTimer) clearTimeout(flushTimer);
                errorMessage = result.message;
                unregisterInteractiveSession();
                ptyProcess.kill();
                return;

            case 'discard':
                if (flushTimer) clearTimeout(flushTimer);
                flushTimer = setTimeout(flushOutput, 500);
                return;
        }
    });

    // Register interactive input handler (for !cancel support)
    registerInteractiveSession((text: string) => {
        const trimmed = text.trim();
        if (trimmed === '!cancel' || trimmed === '!取消') {
            logger.debug('[!login:codex] User cancelled login');
            cancelled = true;
            loginSucceeded = false;
            unregisterInteractiveSession();
            flushOutput();
            ptyProcess.kill();
            return;
        }
        if (exited) return;
        // Forward any other input to PTY (in case codex prompts for something)
        try { ptyProcess.write(text + '\r'); } catch {}
    });

    ptyProcess.onExit(({ exitCode }) => {
        if (finalized) {
            logger.debug(`[!login:codex] onExit re-entry blocked by finalized guard (exitCode=${exitCode})`);
            return;
        }
        finalized = true;
        exited = true;
        logger.info(`[!login:codex] onExit entry: exitCode=${exitCode} loginSucceeded=${loginSucceeded} cancelled=${cancelled} errorMessage=${errorMessage ? JSON.stringify(errorMessage).slice(0, 200) : 'null'}`);
        flushOutput();
        unregisterInteractiveSession();

        // Ordering matters: migrate → restore → register → unlock → notify.
        // The mobile client is told "success" only after the lock is released, so a
        // follow-up !login command from the user can immediately begin.

        // Step 1: migrate the freshly-written auth.json from ~/.codex into the instance.
        // We rely on `loginSucceeded` (set by the PTY 'success' parser) instead of mere
        // existence of defaultAuthPath, because the user's pre-existing auth.json could
        // still be sitting there if codex never completed login.
        let migrated = false;
        let registerError: Error | null = null;
        try {
            if (loginSucceeded && existsSync(defaultAuthPath)) {
                const stats = statSync(defaultAuthPath);
                mkdirSync(codexInstancePath, { recursive: true });
                copyFileSync(defaultAuthPath, join(codexInstancePath, 'auth.json'));
                migrated = true;
                logger.info(`[!login:codex] step1 migrate: size=${stats.size} mtime=${stats.mtime.toISOString()} → ${join(codexInstancePath, 'auth.json')}`);
            } else {
                logger.info(`[!login:codex] step1 migrate skipped: loginSucceeded=${loginSucceeded} defaultAuthExists=${existsSync(defaultAuthPath)}`);
            }
        } catch (err) {
            registerError = err as Error;
            logger.warn(`[!login:codex] step1 migrate error: ${(err as Error).message}`);
        }

        // Step 2: restore the user's original ~/.codex/auth.json (or remove leftover)
        restoreDefaultAuth();
        logger.info(`[!login:codex] step2 restoreDefaultAuth done (hadOriginal=${hadOriginal})`);

        // Step 3: register profile + link shared dirs (still under lock)
        let isFirstProfile = false;
        if (migrated && !registerError) {
            try {
                isFirstProfile = !readCodexDefaultProfile();
                registerCodexProfile(profileName);
                if (isFirstProfile) {
                    setCodexDefaultProfile(profileName);
                    logger.debug(`[!login:codex] Auto-set default codex profile to "${profileName}" (first profile)`);
                }
                linkCodexSharedDirectories(codexInstancePath);
                syncCodexSessionSharing(codexInstancePath);
                logger.info(`[!login:codex] step3 register+linkShared done (isFirstProfile=${isFirstProfile})`);
            } catch (err) {
                registerError = err as Error;
                logger.warn(`[!login:codex] step3 register error: ${(err as Error).message}`);
            }
        } else {
            logger.info(`[!login:codex] step3 register skipped (migrated=${migrated} registerError=${registerError ? 'set' : 'null'})`);
        }

        // Step 4: release lock — only AFTER all fs ops above complete
        releaseLock();
        logger.info('[!login:codex] step4 releaseLock done');

        // Step 5: notify mobile client (after lock released, so a follow-up !login is safe).
        // Cleanup of half-created instance dir is consolidated here for any non-success branch.
        const finalSuccess = migrated && !registerError;
        if (!finalSuccess && !dirExistedBefore) {
            cleanupInstance(codexInstancePath);
            logger.info(`[!login:codex] cleanupInstance ${codexInstancePath} (was newly created, login failed)`);
        }

        if (finalSuccess) {
            logger.info(`[!login:codex] step5 dispatch=success profile=${profileName} isFirstProfile=${isFirstProfile}`);
            const defaultNote = isFirstProfile ? '\n已自动设为默认账户' : '';
            const msg = `✅ Codex 配置 "${profileName}" 登录成功${defaultNote}\n\n`
                + `切换账号: !auth-all --codex ${profileName}`;
            ctx.client.sendCodexMessage({ type: 'message', message: msg });
        } else if (registerError) {
            logger.warn(`[!login:codex] step5 dispatch=registerError: ${registerError.message}`);
            ctx.client.sendCodexMessage({ type: 'message', message: `⚠️ 登录成功但注册失败: ${registerError.message}` });
        } else if (cancelled) {
            logger.info('[!login:codex] step5 dispatch=cancelled');
            ctx.client.sendCodexMessage({ type: 'message', message: '❌ 登录已取消' });
        } else if (errorMessage) {
            logger.info(`[!login:codex] step5 dispatch=errorMessage: ${errorMessage}`);
            ctx.client.sendCodexMessage({ type: 'message', message: `❌ Codex 登录失败\n\n${errorMessage}` });
        } else {
            const finalStripped = stripTerminalOutput(recentOutput).slice(-1000);
            logger.warn(`[!login:codex] step5 dispatch=genericFailure exitCode=${exitCode ?? 'unknown'} finalOutput=${JSON.stringify(finalStripped)}`);
            const tail = finalStripped.trim();
            const detail = tail ? `\n\nCodex 输出:\n${codeBlock(tail)}` : '';
            ctx.client.sendCodexMessage({ type: 'message', message: `❌ Codex 登录失败或已取消${detail}\n\n重新尝试: !login --codex ${profileName}` });
        }

        ctx.client.sendSessionEvent({ type: 'ready' });
        logger.info(`[!login:codex] END profile=${profileName}`);
    });

    const msg = `🔐 正在登录 Codex...\n\n`
        + `配置: ${profileName}\n\n`
        + '请等待 OAuth 链接，然后在浏览器中打开\n\n'
        + '取消: !cancel';
    return { message: msg, action: 'none' };
}

/**
 * Returns true when `pid` belongs to a still-running process. Uses `process.kill(pid, 0)`,
 * the standard cross-platform liveness probe (Node implements it on Windows too).
 * Rejects 0/negative pids — `process.kill(0, 0)` targets the process group and
 * `process.kill(-1, 0)` targets all signalable processes; neither belongs in a lock file.
 */
function isCodexLoginPidAlive(pid: number | undefined): boolean {
    if (!pid || typeof pid !== 'number' || pid <= 0) return false;
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Lock files older than this are treated as stale even if the recorded pid happens
 * to still be alive (defends against PID reuse — Linux pid_max is typically 32768
 * so reuse cycles in hours under load). Device-auth code TTL is 15 minutes, so a
 * 1-hour ceiling is comfortably above any legitimate login duration.
 */
const CODEX_LOGIN_LOCK_STALE_MS = 60 * 60 * 1000;

/**
 * Recover from an interrupted codex login (parent happy process killed mid-flow).
 * Called once at CLI startup — idempotent, safe when no lock exists.
 *
 * Liveness gate (defends against two failure modes):
 * - Live pid + fresh timestamp → real in-flight login, skip recovery (race protection)
 * - Live pid + stale timestamp → PID reuse after crash, treat as stale and recover
 * - Live pid + missing timestamp → conservative: skip (assume in-flight)
 * - Dead pid (any timestamp) → recover
 *
 * Phase-driven recovery state machine (the structural fix):
 * - phase='started': codex never spawned, defaultAuthPath is the user's untouched
 *   original. Just clean up lock + any orphan backup. Do NOT touch defaultAuthPath.
 * - phase='spawned' + hadOriginal=true + backup exists: restore from backup.
 * - phase='spawned' + hadOriginal=true + no backup: cannot restore (rare crash window
 *   between backup-create and update-lock); log warning, leave defaultAuthPath alone.
 * - phase='spawned' + hadOriginal=false: codex wrote a new auth.json into a previously
 *   empty ~/.codex; delete it (restore "no auth" state, otherwise the user's default
 *   would be silently bound to a happy-managed account).
 *
 * Backwards compat: pre-phase locks used a `backedUp` field and implied that codex
 * had spawned. We map them to phase='spawned' with hadOriginal=backedUp.
 *
 * `codexHome` is exposed for unit tests so they can point at a temp directory; in
 * production the default ~/.codex location is used.
 */
export function recoverInterruptedCodexLogin(codexHome?: string): void {
    const defaultCodexHome = codexHome ?? join(homedir(), '.codex');
    const lockPath = join(defaultCodexHome, '.happy-login.lock');
    if (!existsSync(lockPath)) return;

    const defaultAuthPath = join(defaultCodexHome, 'auth.json');
    const backupAuthPath = join(defaultCodexHome, 'auth.json.happy-bak');

    let info: {
        phase?: string;
        hadOriginal?: boolean;
        backedUp?: boolean; // legacy field for backwards compat with pre-phase locks
        profileName?: string;
        pid?: number;
        started?: string;
    } = {};
    try { info = JSON.parse(readFileSync(lockPath, 'utf-8')); } catch {}

    // Legacy lock format compat: pre-phase locks only had `backedUp` and were always
    // post-spawn semantically (the old code only wrote the lock right before spawning).
    const phase: 'started' | 'spawned' = info.phase === 'started' || info.phase === 'spawned'
        ? info.phase
        : (info.backedUp !== undefined ? 'spawned' : 'started');
    const hadOriginal = info.hadOriginal ?? info.backedUp ?? false;

    const startedAt = info.started ? Date.parse(info.started) : NaN;
    const looksFresh = !Number.isFinite(startedAt) || (Date.now() - startedAt) < CODEX_LOGIN_LOCK_STALE_MS;
    if (isCodexLoginPidAlive(info.pid) && looksFresh) {
        logger.debug(`[!login:codex] Lock held by live pid=${info.pid} (phase=${phase}, started=${info.started ?? 'unknown'}), skipping recovery`);
        return;
    }
    if (isCodexLoginPidAlive(info.pid) && !looksFresh) {
        logger.warn(`[!login:codex] Lock pid=${info.pid} alive but timestamp stale (started=${info.started}), assuming PID reuse and recovering`);
    }

    try {
        if (phase === 'started') {
            // codex never spawned; defaultAuthPath is untouched. Just clean lock + orphan backup.
            logger.info(`[!login:codex] Cleared codex login lock from pre-spawn crash (profile=${info.profileName ?? 'unknown'})`);
        } else {
            // phase === 'spawned' — codex MAY have written defaultAuthPath
            const backupExists = existsSync(backupAuthPath);
            if (hadOriginal && backupExists) {
                copyFileSync(backupAuthPath, defaultAuthPath);
                logger.info(`[!login:codex] Recovered ~/.codex/auth.json from interrupted login (profile=${info.profileName ?? 'unknown'})`);
            } else if (hadOriginal && !backupExists) {
                // Rare crash window: backup creation completed but lock update to spawned
                // didn't, OR backup was lost. Don't touch defaultAuthPath — the user's
                // original may still be there.
                logger.warn(`[!login:codex] Lock indicates backup but file is missing — cannot restore (profile=${info.profileName ?? 'unknown'})`);
            } else if (!hadOriginal && existsSync(defaultAuthPath)) {
                rmSync(defaultAuthPath, { force: true });
                logger.info('[!login:codex] Removed leftover auth.json from interrupted login (no original to restore)');
            }
        }
        rmSync(backupAuthPath, { force: true });
    } catch (err) {
        logger.warn('[!login:codex] Recovery failed', err);
    }

    try { rmSync(lockPath, { force: true }); } catch {}
}
