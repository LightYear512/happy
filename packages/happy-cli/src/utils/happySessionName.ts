import { basename } from 'node:path';

export const HAPPY_CONSOLE_NAME = 'happy 控制台';

export function stableHappySessionName(metadata: {
    name?: unknown;
    path?: unknown;
    consoleSession?: unknown;
}): string {
    const existing = typeof metadata.name === 'string' ? metadata.name.trim() : '';
    if (existing) return validName(existing);
    if (metadata.consoleSession === true) return HAPPY_CONSOLE_NAME;
    const fromPath = typeof metadata.path === 'string' ? basename(metadata.path.trim()) : '';
    return validName(fromPath || 'Happy');
}

function validName(value: string): string {
    if (!value || Buffer.byteLength(value, 'utf8') > 64 || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new Error('Invalid Happy session name');
    }
    return value;
}
