import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import { logger } from '@/ui/logger';
import {
    hasActiveInteractiveSession,
    registerInteractiveSession,
    unregisterInteractiveSession,
} from './interactiveSession';
import type { BangCommandContext, BangCommandResult } from './types';

const PROFILE_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

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

        return { action: 'discard' };
    }

    return { action: 'forward' };
}

/** Find the Claude CLI binary path. */
function findClaudeCli(): { path: string; needsShell: boolean } | null {
    // Check CCS_CLAUDE_PATH override first
    if (process.env.CCS_CLAUDE_PATH) {
        const ccsPath = process.env.CCS_CLAUDE_PATH;
        if (existsSync(ccsPath)) {
            const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(ccsPath);
            return { path: ccsPath, needsShell };
        }
    }

    const isWindows = process.platform === 'win32';

    try {
        const cmd = isWindows ? 'where.exe claude' : 'which claude';
        const result = execSync(cmd, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000,
        }).trim();

        const matches = result.split('\n').map(p => p.trim()).filter(Boolean);

        if (isWindows) {
            const withExt = matches.find(p => /\.(exe|cmd|bat)$/i.test(p));
            const claudePath = withExt || matches[0];
            if (claudePath && existsSync(claudePath)) {
                return { path: claudePath, needsShell: /\.(cmd|bat)$/i.test(claudePath) };
            }
        } else if (matches[0] && existsSync(matches[0])) {
            return { path: matches[0], needsShell: false };
        }
    } catch { /* claude not in PATH */ }

    return null;
}

/** Register a new profile in CCS profiles.json. */
function registerProfile(
    profileName: string,
    contextMode: 'isolated' | 'shared',
    contextGroup?: string,
): void {
    const ccsDir = getCcsDir();
    const profilesPath = join(ccsDir, 'profiles.json');

    let data: Record<string, unknown> = {};
    if (existsSync(profilesPath)) {
        try {
            data = JSON.parse(readFileSync(profilesPath, 'utf-8'));
        } catch {
            data = {};
        }
    }

    data[profileName] = {
        type: 'account',
        created: new Date().toISOString(),
        last_used: null,
        context_mode: contextMode,
        ...(contextGroup ? { context_group: contextGroup } : {}),
    };

    mkdirSync(ccsDir, { recursive: true });
    const tmpPath = profilesPath + '.' + randomBytes(4).toString('hex') + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpPath, profilesPath);
    logger.debug(`[!auth create] Registered profile "${profileName}" in ${profilesPath}`);
}

/** Remove instance directory on failure. */
function cleanupInstance(instancePath: string): void {
    try {
        if (existsSync(instancePath)) {
            rmSync(instancePath, { recursive: true, force: true });
        }
    } catch (err) {
        logger.debug('[!auth create] Failed to cleanup instance:', err);
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
export async function handleAuthCreateBangCommand(
    args: string,
    ctx: BangCommandContext,
): Promise<BangCommandResult> {
    if (hasActiveInteractiveSession()) {
        return {
            message: '❌ 已有登录流程进行中\n\n发送 `!cancel` 取消当前流程',
            action: 'none',
        };
    }

    // Parse: <name> [--isolated] [--group <group>]
    // Default: shared context mode (most useful for mobile profile switching)
    const parts = args.split(/\s+/).filter(Boolean);
    const profileName = parts[0];

    if (!profileName) {
        return {
            message: '❌ 需要配置名称\n\n用法: `!login <名称>`',
            action: 'none',
        };
    }

    if (!PROFILE_NAME_REGEX.test(profileName)) {
        return {
            message: '❌ 无效的配置名称\n\n字母开头，仅含字母/数字/_/-',
            action: 'none',
        };
    }

    // Check existing
    const ccsDir = getCcsDir();
    const profilesPath = join(ccsDir, 'profiles.json');
    if (existsSync(profilesPath)) {
        try {
            const data = JSON.parse(readFileSync(profilesPath, 'utf-8'));
            if (data[profileName]) {
                return {
                    message: `❌ 配置 "${profileName}" 已存在`,
                    action: 'none',
                };
            }
        } catch { /* ignore parse errors */ }
    }

    // Parse context flags
    const hasIsolated = parts.includes('--isolated');
    const groupIdx = parts.indexOf('--group');
    const contextGroup = groupIdx !== -1 && parts[groupIdx + 1]
        ? parts[groupIdx + 1]
        : (hasIsolated ? undefined : 'default');
    const contextMode: 'isolated' | 'shared' = hasIsolated ? 'isolated' : 'shared';

    // Find Claude CLI
    const claudeInfo = findClaudeCli();
    if (!claudeInfo) {
        return {
            message: '❌ 未找到 Claude CLI\n\n请先安装 Claude Code',
            action: 'none',
        };
    }

    // Create instance directory
    const instancePath = getInstancePath(profileName);
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
                cols: 120,
                rows: 30,
                cwd: homedir(), // Use home dir — no project = no workspace trust prompt
                env: cleanEnv,
            },
        );
    } catch (err) {
        cleanupInstance(instancePath);
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
            ctx.client.sendCodexMessage({ type: 'message', message: '```\n' + text + '\n```' });
        }
    };

    let loginUrlSent = false;
    let loginCommandSent = false;

    ptyProcess.onData((data: string) => {
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
                logger.debug(`[!login] OAuth URL detected: ${result.url}`);
                outputBuffer = '';
                if (flushTimer) clearTimeout(flushTimer);

                ctx.client.sendCodexMessage({ type: 'message', message:
                    '🔗 请在浏览器中打开以下链接登录:\n\n```\n' + result.url + '\n```\n\n登录后将 OAuth Key 粘贴到下方发送'
                });
                return;

            case 'discard':
                // Keep accumulating — don't clear buffer during phase 1.
                // The buffer grows until we match a URL or an auto-respond prompt.
                return;

            case 'forward': {
                // Detect "Login successful" → auto-send Enter, then kill process
                const forwardText = stripAnsiOnly(outputBuffer);
                if (forwardText.includes('Login successful')) {
                    logger.debug('[!login] Login successful detected, sending Enter and finishing');
                    outputBuffer = '';
                    if (flushTimer) clearTimeout(flushTimer);
                    ptyProcess.write('\r');
                    // Give Claude a moment to save credentials, then kill
                    setTimeout(() => { try { ptyProcess.kill(); } catch {} }, 2000);
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
            logger.debug('[!auth create] User cancelled login');
            unregisterInteractiveSession();
            flushOutput();
            ptyProcess.kill();
            cleanupInstance(instancePath);
            ctx.client.sendCodexMessage({ type: 'message', message: '❌ 登录已取消' });
            ctx.client.sendSessionEvent({ type: 'ready' });
            return;
        }

        if (exited) {
            logger.debug('[!auth create] Process already exited, ignoring input');
            return;
        }

        logger.debug('[!auth create] Feeding input to Claude PTY');
        try {
            ptyProcess.write(text + '\r');
        } catch (err) {
            logger.debug('[!auth create] Failed to write to PTY:', err);
        }
    });

    // Handle process exit
    ptyProcess.onExit(({ exitCode }) => {
        exited = true;
        flushOutput();
        unregisterInteractiveSession();

        const credPath = join(instancePath, '.credentials.json');
        const hasCredentials = existsSync(credPath);

        if (hasCredentials) {
            try {
                registerProfile(profileName, contextMode, contextGroup);
                const modeDesc = contextMode === 'shared'
                    ? `共享 (组: ${contextGroup || 'default'})`
                    : '独立';
                const msg = `✅ 配置 "${profileName}" 创建成功\n\n`
                    + `模式: ${modeDesc}\n\n`
                    + `切换账号: !auth ${profileName}`;
                ctx.client.sendCodexMessage({ type: 'message', message: msg });
            } catch (err) {
                logger.debug('[!auth create] Failed to register profile:', err);
                ctx.client.sendCodexMessage({ type: 'message', message: `⚠️ 登录成功但注册失败: ${(err as Error).message}` });
            }
        } else {
            cleanupInstance(instancePath);
            ctx.client.sendCodexMessage({ type: 'message', message: `❌ 登录失败或已取消 (退出码: ${exitCode ?? 'unknown'})` });
        }

        ctx.client.sendSessionEvent({ type: 'ready' });
    });

    // Return immediately — the interactive session runs asynchronously
    const msg = `🔐 正在启动登录...\n\n`
        + `配置: ${profileName} (${contextMode === 'shared' ? '共享' : '独立'})\n\n`
        + '请等待登录提示，然后粘贴 OAuth Key\n\n'
        + '取消: !cancel';
    return { message: msg, action: 'none' };
}
