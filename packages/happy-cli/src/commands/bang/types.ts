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
}

export interface BangCommandResult {
    /** Message to send back to the mobile client */
    message: string;
    /** Action to perform after sending the message */
    action: 'none';
}

export type BangCommandHandler = (args: string, ctx: BangCommandContext) => Promise<BangCommandResult>;
