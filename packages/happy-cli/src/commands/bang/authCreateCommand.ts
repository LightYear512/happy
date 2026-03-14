import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import { logger } from '@/ui/logger';
import { centerText } from './format';
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
 * Aggressively strip all terminal escape sequences and TUI artifacts.
 * Handles CSI, OSC, DCS, cursor control, private modes, and box-drawing characters.
 */
function stripTerminalOutput(text: string): string {
    return text
        // CSI sequences: ESC[ (params) (intermediates) (final byte)
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B\[[\x20-\x3F]*[\x30-\x3F]*[\x40-\x7E]/g, '')
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
        // Control characters (except newline/tab)
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // Box-drawing and block Unicode characters used by TUI
        .replace(/[─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┘├┤┬┴┼╋╌╍╎╏═║╔╗╚╝╟╠╡╢╣╤╥╦╧╨╩╪╫╬▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕╭╮╯╰╱╲╳╴╵╶╷╸╹╺╻╼╽╾╿·•…‥‧]+/g, '')
        // Collapse excessive whitespace/blank lines
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+$/gm, '')
        .trim();
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
 * Handle `!auth create <name>` — create a new CCS profile via interactive Claude login.
 *
 * Flow:
 * 1. Validate profile name, create instance directory
 * 2. Spawn `claude` with CLAUDE_CONFIG_DIR pointing to the instance
 * 3. Forward Claude's login prompt output to mobile
 * 4. User pastes OAuth key on mobile → piped to Claude's stdin
 * 5. On successful login (.credentials.json appears), register profile
 */
export async function handleAuthCreateBangCommand(
    args: string,
    ctx: BangCommandContext,
): Promise<BangCommandResult> {
    if (hasActiveInteractiveSession()) {
        return {
            message: centerText(['❌ 已有登录流程进行中', '', '发送 !cancel 取消当前流程']),
            action: 'none',
        };
    }

    // Parse: <name> [--shared|-s] [--group <group>]
    const parts = args.split(/\s+/).filter(Boolean);
    const profileName = parts[0];

    if (!profileName) {
        return {
            message: centerText(['❌ 需要配置名称', '', '用法: !auth create <名称>']),
            action: 'none',
        };
    }

    if (!PROFILE_NAME_REGEX.test(profileName)) {
        return {
            message: centerText(['❌ 无效的配置名称', '', '字母开头，仅含字母/数字/_/-']),
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
                    message: centerText([`❌ 配置 "${profileName}" 已存在`]),
                    action: 'none',
                };
            }
        } catch { /* ignore parse errors */ }
    }

    // Parse context flags
    const hasShared = parts.includes('--shared') || parts.includes('-s');
    const groupIdx = parts.indexOf('--group');
    const contextGroup = groupIdx !== -1 && parts[groupIdx + 1]
        ? parts[groupIdx + 1]
        : (hasShared ? 'default' : undefined);
    const contextMode: 'isolated' | 'shared' = hasShared ? 'shared' : 'isolated';

    // Find Claude CLI
    const claudeInfo = findClaudeCli();
    if (!claudeInfo) {
        return {
            message: centerText(['❌ 未找到 Claude CLI', '', '请先安装 Claude Code']),
            action: 'none',
        };
    }

    // Create instance directory
    const instancePath = getInstancePath(profileName);
    try {
        mkdirSync(instancePath, { recursive: true });
    } catch (err) {
        return {
            message: centerText([`❌ 创建实例目录失败: ${(err as Error).message}`]),
            action: 'none',
        };
    }

    // Pre-create a minimal settings.json to skip the onboarding TUI wizard.
    // Without this, Claude shows a full-screen theme selector that's unusable on mobile.
    const settingsPath = join(instancePath, 'settings.json');
    if (!existsSync(settingsPath)) {
        writeFileSync(settingsPath, '{}', 'utf-8');
        logger.debug('[!auth create] Pre-created minimal settings.json to skip onboarding');
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
                cwd: process.cwd(),
                env: cleanEnv,
            },
        );
    } catch (err) {
        cleanupInstance(instancePath);
        return {
            message: centerText([`❌ 启动 Claude 失败: ${(err as Error).message}`]),
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
            ctx.client.sendSessionEvent({ type: 'message', message: text });
        }
    };

    ptyProcess.onData((data: string) => {
        outputBuffer += data;
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(flushOutput, 300);
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
            ctx.client.sendSessionEvent({
                type: 'message',
                message: centerText(['❌ 登录已取消']),
            });
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
                const lines = [
                    `✅ 配置 "${profileName}" 创建成功`,
                    '',
                    `模式: ${modeDesc}`,
                    '',
                    `使用 !auth ${profileName} 切换`,
                ];
                ctx.client.sendSessionEvent({ type: 'message', message: centerText(lines) });
            } catch (err) {
                logger.debug('[!auth create] Failed to register profile:', err);
                ctx.client.sendSessionEvent({
                    type: 'message',
                    message: centerText([`⚠️ 登录成功但注册失败: ${(err as Error).message}`]),
                });
            }
        } else {
            cleanupInstance(instancePath);
            const lines = [
                '❌ 登录失败或已取消',
                '',
                `退出码: ${exitCode ?? 'unknown'}`,
            ];
            ctx.client.sendSessionEvent({ type: 'message', message: centerText(lines) });
        }

        ctx.client.sendSessionEvent({ type: 'ready' });
    });

    // Return immediately — the interactive session runs asynchronously
    const lines = [
        '🔐 正在启动登录...',
        '',
        `配置: ${profileName}`,
        `模式: ${contextMode === 'shared' ? '共享' : '独立'}`,
        '',
        '请等待登录提示，然后粘贴 OAuth Key',
        '发送 !cancel 取消',
    ];
    return { message: centerText(lines), action: 'none' };
}
