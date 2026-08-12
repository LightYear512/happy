import { createHash } from 'node:crypto';

const INPUT_ACCEPTED_EVENT_PREFIX = 'happy-input-accepted-v1-';

export function inputAcceptedEventId(localId: string): string {
    const digest = createHash('sha256').update(localId, 'utf8').digest('hex');
    return `${INPUT_ACCEPTED_EVENT_PREFIX}${digest}`;
}
