import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deterministicStringify } from '@/utils/deterministicJson';
import { createSessionTransportHealthReporter, parseSessionTransportHealthRecord,
    readSessionTransportHealthRecord } from './sessionTransportHealth';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('session transport health receipt', () => {
    it('HSR uses the XC canonical cross-runtime health digest fixture', () => {
        const fixture = {
            schema: 'xc.happy-session-transport-health.v1', nativeSessionId: 'native-fixture', processId: 123,
            processStartedAt: '2026-07-11T00:00:00.000Z', generation: 1, state: 'connected', reconnectCount: 0,
            queueMessages: 0, queueBytes: 0, reason: null, connectedAt: '2026-07-11T00:00:01.000Z',
            disconnectedAt: null, updatedAt: '2026-07-11T00:00:01.000Z',
        };
        expect(`sha256:${createHash('sha256').update(deterministicStringify(fixture)).digest('hex')}`)
            .toBe('sha256:70243147c25f619523ace14f6959ca8c18720a37d4d45b427683cf63a3a9e0ba');
    });

    it('HSR writes an atomic digest-bound receipt only inside an XC workspace', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happy-health-'));
        roots.push(workspace);
        mkdirSync(join(workspace, '.virtual-session'), { recursive: true });
        const reporter = createSessionTransportHealthReporter(workspace, 'native-session-1');
        expect(reporter).not.toBeNull();

        const published = reporter!.write('connected', {
            reconnectCount: 1, queueMessages: 2, queueBytes: 64, reason: null,
        });
        const path = join(workspace, '.virtual-session', 'runtime', 'provider-health', 'happy', 'native-session-1.json');
        const receipt = JSON.parse(readFileSync(path, 'utf8'));
        const { recordDigest, ...base } = receipt;
        const expected = `sha256:${createHash('sha256').update(deterministicStringify(base)).digest('hex')}`;
        expect(recordDigest).toBe(expected);
        expect(receipt.state).toBe('connected');
        expect(receipt.nativeSessionId).toBe('native-session-1');
        expect(receipt.queueMessages).toBe(2);
        expect(published).toEqual(receipt);
        await expect(readSessionTransportHealthRecord(workspace, 'native-session-1')).resolves.toEqual(receipt);
        expect(existsSync(`${path}.tmp`)).toBe(false);
        expect(statSync(join(workspace, '.virtual-session', 'runtime', 'provider-health', 'happy')).mode & 0o077).toBe(0);
    });

    it('HSR remains disabled outside an XC workspace', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happy-health-disabled-'));
        roots.push(workspace);
        expect(createSessionTransportHealthReporter(workspace, 'native-session-1')).toBeNull();
    });

    it('HSR bounds reasons and rejects unsafe session identities', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happy-health-bounds-'));
        roots.push(workspace);
        mkdirSync(join(workspace, '.virtual-session'), { recursive: true });
        expect(createSessionTransportHealthReporter(workspace, '../escape')).toBeNull();
        const reporter = createSessionTransportHealthReporter(workspace, 'native-session-2');
        reporter!.write('failed', { reconnectCount: 1, queueMessages: 0, queueBytes: 0, reason: 'x'.repeat(2_000) });
        const receipt = JSON.parse(readFileSync(join(
            workspace, '.virtual-session', 'runtime', 'provider-health', 'happy', 'native-session-2.json',
        ), 'utf8'));
        expect(Buffer.byteLength(receipt.reason, 'utf8')).toBeLessThanOrEqual(512);
    });

    it('HSR preserves the connection transition time across heartbeat writes', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happy-health-heartbeat-'));
        roots.push(workspace);
        mkdirSync(join(workspace, '.virtual-session'), { recursive: true });
        const reporter = createSessionTransportHealthReporter(workspace, 'native-session-3');
        reporter!.write('connected', { reconnectCount: 0, queueMessages: 0, queueBytes: 0, reason: null });
        const path = join(workspace, '.virtual-session', 'runtime', 'provider-health', 'happy', 'native-session-3.json');
        const first = JSON.parse(readFileSync(path, 'utf8'));
        await new Promise((resolve) => setTimeout(resolve, 2));
        reporter!.write('connected', { reconnectCount: 0, queueMessages: 0, queueBytes: 0, reason: null });
        const second = JSON.parse(readFileSync(path, 'utf8'));
        expect(second.connectedAt).toBe(first.connectedAt);
        expect(second.generation).toBe(first.generation + 1);
    });

    it('HSR rejects altered and path-escaping current-process evidence', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happy-health-hostile-'));
        roots.push(workspace);
        mkdirSync(join(workspace, '.virtual-session'), { recursive: true });
        const reporter = createSessionTransportHealthReporter(workspace, 'native-session-4');
        const record = reporter!.write('connected', {
            reconnectCount: 0, queueMessages: 0, queueBytes: 0, reason: null,
        });
        expect(parseSessionTransportHealthRecord(record)).toEqual(record);
        expect(() => parseSessionTransportHealthRecord({ ...record, generation: record.generation + 1 }))
            .toThrow(/digest/u);
        expect(() => parseSessionTransportHealthRecord({ ...record, extra: true }))
            .toThrow(/invalid/u);
        await expect(readSessionTransportHealthRecord(workspace, '../native-session-4')).resolves.toBeNull();
    });
});
