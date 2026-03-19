import { ApiSessionClient } from '@/api/apiSession';
import { Session } from '@/claude/session';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { EnhancedMode } from '@/claude/loop';

/**
 * Context available to bang command handlers.
 * Bang commands are prefixed with `!` and intercepted before reaching Claude.
 */
export interface BangCommandContext {
    /** API session client for sending messages back to mobile */
    client: ApiSessionClient;
    /** Current Claude session (may be null during startup) */
    session: Session | null;
    /** Message queue for pushing synthetic messages (e.g., /clear) */
    messageQueue: MessageQueue2<EnhancedMode>;
    /** Current enhanced mode for queue operations */
    currentEnhancedMode: EnhancedMode;
    /** Whether this is the daemon console session (lightweight, bang-command-only) */
    isConsoleSession?: boolean;
}

export interface BangCommandResult {
    /** Message(s) to send back to the mobile client. Array = multiple chat bubbles. */
    message: string | string[];
    /** Action to perform after sending the message */
    action: 'none' | 'restart-session';
}

export type BangCommandHandler = (args: string, ctx: BangCommandContext) => Promise<BangCommandResult>;
