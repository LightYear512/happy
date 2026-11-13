import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rmdir, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { diagnosticTrace, flushDiagnosticTrace } from '@/ui/logger';
import { createAppServerStreamBridge } from '../appServerStreamBridge';
import { createCodexRawItemDiagnostics } from './codexRawItemDiagnostics';

const originalSelection = process.env.HAPPY_CODEX_RAW_ITEM_DIAGNOSTICS_SESSION;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
afterEach(() => {
    if (originalSelection === undefined) delete process.env.HAPPY_CODEX_RAW_ITEM_DIAGNOSTICS_SESSION;
    else process.env.HAPPY_CODEX_RAW_ITEM_DIAGNOSTICS_SESSION = originalSelection;
});

async function rows(sessionId: string): Promise<Array<{
    sessionSha256: string; id: { prefix: string }; sequence: number;
}>> {
    const file = await flushDiagnosticTrace();
    if (!file) return [];
    return (await readFile(file, 'utf8')).split('\n')
        .filter((line) => line.includes('[CODEX_RAW_ITEM] '))
        .map((line) => JSON.parse(line.slice(line.indexOf('[CODEX_RAW_ITEM] ') + 17)))
        .filter((row) => row.sessionSha256 === hash(sessionId));
}

function enabled(sessionId: string): ReturnType<typeof createCodexRawItemDiagnostics> {
    process.env.HAPPY_CODEX_RAW_ITEM_DIAGNOSTICS_SESSION = sessionId;
    return createCodexRawItemDiagnostics(sessionId);
}

describe('Codex raw item diagnostics — real local logging', () => {
    it('is off by default and refuses a different session or a boolean flag without reading the event', async () => {
        const event = Object.defineProperty({}, 'item', { get() { throw new Error('must not read'); } });
        for (const selection of [undefined, '', '1', 'some-other-session']) {
            if (selection === undefined) delete process.env.HAPPY_CODEX_RAW_ITEM_DIAGNOSTICS_SESSION;
            else process.env.HAPPY_CODEX_RAW_ITEM_DIAGNOSTICS_SESSION = selection;
            expect(createCodexRawItemDiagnostics('disabled-session')(event)).toBeUndefined();
        }
        expect(await rows('disabled-session')).toEqual([]);
    });

    it('writes only bounded allowlisted metadata and leaves the frozen notification unchanged', async () => {
        const sessionId = 'privacy-session';
        const secret = 'DO_NOT_LOG_AUTH_BODY_ARGUMENTS_OR_CIPHERTEXT';
        const item = Object.freeze({ type: 'function_call', id: 'item_private-id', call_id: 'call_private-id',
            name: 'send_message', namespace: 'collaboration', arguments: secret, encrypted_content: secret,
            content: [{ text: secret }], [secret]: secret });
        const event = Object.freeze({ threadId: 'private-thread', turnId: 'private-turn', item, authorization: secret });
        const before = JSON.stringify(event);
        const observe = enabled(sessionId);
        expect(observe(event)).toBeUndefined();
        expect(JSON.stringify(event)).toBe(before);
        const logged = await rows(sessionId);
        expect(logged).toHaveLength(1);
        expect(logged[0]).toEqual({ sessionSha256: hash(sessionId), threadSha256: hash('private-thread'),
            turnSha256: hash('private-turn'), sequence: 1, itemType: 'function_call',
            id: { prefix: 'item_', length: 15, sha256: hash('item_private-id') },
            callSha256: hash('call_private-id'), namespace: 'collaboration', tool: 'send_message',
            encryptedContentPresent: true });
        const output = JSON.stringify(logged);
        for (const value of [secret, sessionId, 'private-thread', 'private-turn', 'item_private-id', 'call_private-id']) {
            expect(output).not.toContain(value);
        }
        expect(output.length).toBeLessThan(1024);
    });

    it('does not traverse content, arguments, summaries or dynamic keys', async () => {
        const item = { type: 'reasoning', id: 'rs_ok' };
        for (const key of ['content', 'arguments', 'summary']) Object.defineProperty(item, key, {
            enumerable: true, get() { throw new Error('private payload must not be read'); },
        });
        enabled('no-traversal-session')({ item });
        expect(await rows('no-traversal-session')).toHaveLength(1);
    });

    it('reserves 128 generic samples after 16 normal samples and stops formatting at capacity', async () => {
        const observe = enabled('capacity-session');
        for (let index = 0; index < 100; index++) observe({ item: { type: 'reasoning', id: `rs_${index}` } });
        for (let index = 0; index < 150; index++) observe({ item: { type: 'reasoning', id: `item_${index}` } });
        const unreadable = Object.defineProperty({}, 'item', { get() { throw new Error('capacity must short circuit'); } });
        expect(observe(unreadable)).toBeUndefined();
        const logged = await rows('capacity-session');
        expect(logged).toHaveLength(144);
        expect(logged.filter((row) => row.id.prefix === 'rs_')).toHaveLength(16);
        expect(logged.filter((row) => row.id.prefix === 'item_')).toHaveLength(128);
        expect(logged.at(-1)?.sequence).toBe(144);
    });

    it('classifies unknown fields without logging their values or hashing oversized identifiers', async () => {
        const secret = 'secret'.repeat(100_000);
        const observe = enabled('oversize-session');
        for (const event of [null, [], 1, 'bad', {}, { item: [] }]) expect(observe(event)).toBeUndefined();
        observe({ threadId: secret, item: { id: secret, type: secret, name: secret, namespace: secret } });
        const logged = await rows('oversize-session');
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({ threadSha256: null, itemType: 'other', namespace: 'other', tool: 'other',
            id: { prefix: 'other', length: secret.length, sha256: null } });
        expect(JSON.stringify(logged)).not.toContain('secret');
        expect(JSON.stringify(logged).length).toBeLessThan(1024);
    });

    it('contains extraction failure without changing the existing bridge result', async () => {
        const observe = enabled('extraction-failure-session');
        const broken = Object.defineProperty({}, 'item', { get() { throw new Error('injected extraction failure'); } });
        expect(observe(broken)).toBeUndefined();
        const event = { item: { type: 'message', id: 'msg_next', content: [] } };
        const bridge = createAppServerStreamBridge();
        const expected = bridge.onNotification('rawResponseItem/completed', event);
        observe(event);
        expect(bridge.onNotification('rawResponseItem/completed', event)).toEqual(expected);
        expect(await rows('extraction-failure-session')).toEqual([]);
    });

    it('does not propagate real filesystem write failure or wait for the write', async () => {
        diagnosticTrace('[DIAGNOSTIC_TEST]', 'initialize the dedicated test process log');
        const file = await flushDiagnosticTrace();
        expect(file).not.toBeNull();
        const saved = `${file}.write-failure-test`;
        await rename(file!, saved);
        await mkdir(file!);
        try {
            const observe = enabled('write-failure-session');
            expect(observe({ item: { type: 'message', id: 'msg_local' } })).toBeUndefined();
            expect(await flushDiagnosticTrace()).toBe(file);
            expect((await stat(file!)).isDirectory()).toBe(true);
        } finally {
            await rmdir(file!);
            await rename(saved, file!);
        }
    });
});
