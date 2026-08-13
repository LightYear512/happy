import { createHash } from 'node:crypto';
import type { UserMessage } from '@/api/types';
import { diagnosticTrace } from '@/ui/logger';

// JSON escaping can expand one input byte to six characters. Keeping the raw
// excerpt at 8 KiB guarantees one structured record remains below Logger's
// 64 KiB record ceiling even for control-character-heavy input.
const MAX_LOGGED_INPUT_BYTES = 8 * 1024;

export interface UserInputTrace {
    sessionId: string;
    inputId: string;
}

export interface QueuedUserInputTrace extends UserInputTrace {
    content: string;
}

export function createUserInputTrace(sessionId: string, message: UserMessage): UserInputTrace {
    const inputId = message.localKey ?? `sha256:${createHash('sha256')
        .update(sessionId, 'utf8')
        .update('\0', 'utf8')
        .update(message.content.text, 'utf8')
        .digest('hex')}`;
    return { sessionId, inputId };
}

export function logUserInputStage(
    stage: string,
    trace: UserInputTrace,
    content: string,
    details: Record<string, unknown> = {},
): void {
    if (stage !== 'persisted-received') {
        diagnosticTrace('[USER_INPUT]', JSON.stringify({
            stage,
            sessionId: trace.sessionId,
            inputId: trace.inputId,
            ...details,
        }));
        return;
    }

    const bytes = Buffer.from(content, 'utf8');
    const logged = bytes.length <= MAX_LOGGED_INPUT_BYTES
        ? content
        : bytes.subarray(0, MAX_LOGGED_INPUT_BYTES).toString('utf8');
    diagnosticTrace('[USER_INPUT]', JSON.stringify({
        stage,
        sessionId: trace.sessionId,
        inputId: trace.inputId,
        content: logged,
        contentBytes: bytes.length,
        contentSha256: createHash('sha256').update(bytes).digest('hex'),
        contentTruncated: bytes.length > MAX_LOGGED_INPUT_BYTES,
        ...details,
    }));
}
