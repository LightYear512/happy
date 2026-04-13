/** Visual separator line for bang command output. */
export const SEPARATOR = '━━━━━━━━━━━━━━━━━━';

/** Wrap text in a markdown code block for codex messages (renders with copy button on mobile). */
export function codeBlock(text: string): string {
    return '```\n' + text + '\n```';
}

import { ApiSessionClient } from '@/api/apiSession';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { EnhancedMode } from '@/claude/loop';

/**
 * Minimal session shape consumed by bang command handlers.
 *
 * Decoupled from `@/claude/session` so that non-Claude agents (Codex, Gemini)
 * can supply a structurally compatible value or pass `null`. Only the fields
 * actually read by handlers belong here.
 */
export interface BangSessionLike {
    /** Local terminal session vs remote-controlled session. */
    mode: 'local' | 'remote';
}

/**
 * Context available to bang command handlers.
 * Bang commands are prefixed with `!` and intercepted before reaching the agent.
 */
export interface BangCommandContext {
    /** API session client for sending messages back to mobile */
    client: ApiSessionClient;
    /** Current agent session (may be null for codex/gemini and during startup) */
    session: BangSessionLike | null;
    /** Message queue for pushing synthetic messages (e.g., /clear) */
    messageQueue: MessageQueue2<EnhancedMode>;
    /** Current enhanced mode for queue operations */
    currentEnhancedMode: EnhancedMode;
    /** Whether this is the daemon console session (lightweight, bang-command-only) */
    isConsoleSession?: boolean;
    /** Agent flavor — used by handlers that need to branch on backend (e.g., !restart) */
    flavor?: 'claude' | 'codex' | 'gemini';
}

export interface BangCommandResult {
    /** Message(s) to send back to the mobile client. Array = multiple chat bubbles. */
    message: string | string[];
    /** Action to perform after sending the message */
    action: 'none' | 'restart-session';
    /** Optional clickable quick-reply suggestions rendered as <options> buttons after the message. */
    suggestions?: string[];
}

export type BangCommandHandler = (args: string, ctx: BangCommandContext) => Promise<BangCommandResult>;

/** Parse `--codex` flag from args string; returns cleaned args and whether flag was present. */
export function parseCodexFlag(args: string): { cleanArgs: string; hasCodexFlag: boolean } {
    const hasCodexFlag = /(?:^|\s)--codex(?:\s|$)/.test(args);
    const cleanArgs = args.replace(/\s*--codex(?:\s|$)/, ' ').replace(/\s+/g, ' ').trim();
    return { cleanArgs, hasCodexFlag };
}

/**
 * Reject `--codex` flag in non-console contexts. Normal sessions are flavor-pinned
 * by `ctx.flavor` — cross-flavor management belongs in the console.
 *
 * Returns null when the call is allowed, an error result when it should be blocked.
 */
export function rejectCodexFlagInSession(args: string, ctx: BangCommandContext): BangCommandResult | null {
    if (ctx.isConsoleSession) return null;
    if (!/(?:^|\s)--codex(?:\s|$)/.test(args)) return null;
    return {
        message: '❌ 普通会话不支持 --codex 标志\n\n跨 flavor 管理请在控制台中操作；codex 会话内直接使用命令即可（无需 --codex）',
        action: 'none',
    };
}
