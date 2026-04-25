import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    findRolloutByConversationId,
    parseConversationIdFromRolloutFilename,
    getDefaultCodexSessionsRoot,
} from './rolloutDiscovery';

describe('parseConversationIdFromRolloutFilename', () => {
    it('extracts UUID from rollout filename', () => {
        const id = parseConversationIdFromRolloutFilename(
            '/tmp/rollout-2026-04-24T18-33-26-019dbf0d-31b5-7f32-8752-650ea9293aed.jsonl',
        );
        expect(id).toBe('019dbf0d-31b5-7f32-8752-650ea9293aed');
    });

    it('lowercases UUID for case-insensitive match', () => {
        const id = parseConversationIdFromRolloutFilename(
            'rollout-2026-04-24T18-33-26-019DBF0D-31B5-7F32-8752-650EA9293AED.jsonl',
        );
        expect(id).toBe('019dbf0d-31b5-7f32-8752-650ea9293aed');
    });

    it('returns null for non-rollout filenames', () => {
        expect(parseConversationIdFromRolloutFilename('history.jsonl')).toBeNull();
        expect(parseConversationIdFromRolloutFilename('rollout-no-uuid.jsonl')).toBeNull();
    });
});

describe('getDefaultCodexSessionsRoot', () => {
    it('uses $CODEX_HOME/sessions when set', () => {
        const original = process.env.CODEX_HOME;
        process.env.CODEX_HOME = '/custom/codex';
        try {
            expect(getDefaultCodexSessionsRoot()).toBe(join('/custom/codex', 'sessions'));
        } finally {
            if (original === undefined) delete process.env.CODEX_HOME;
            else process.env.CODEX_HOME = original;
        }
    });
});

describe('findRolloutByConversationId', () => {
    let root: string;
    const targetId = '019dbf0d-31b5-7f32-8752-650ea9293aed';
    const otherId = '019dbe62-3733-7b61-94a5-8f7ebdf5741d';

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'rollout-test-'));
        // Layout: root/2026/04/24/rollout-...-<id>.jsonl
        await mkdir(join(root, '2026', '04', '24'), { recursive: true });
        await mkdir(join(root, '2026', '04', '23'), { recursive: true });
        await mkdir(join(root, '2025', '12', '01'), { recursive: true });
        await writeFile(
            join(root, '2026', '04', '24', `rollout-2026-04-24T18-33-26-${targetId}.jsonl`),
            '',
        );
        await writeFile(
            join(root, '2026', '04', '23', `rollout-2026-04-23T11-25-58-${otherId}.jsonl`),
            '',
        );
        await writeFile(join(root, '2026', '04', '24', 'random-file.txt'), '');
    });

    afterAll(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('locates rollout by exact conversationId match', async () => {
        const found = await findRolloutByConversationId(root, targetId);
        expect(found).not.toBeNull();
        expect(found).toContain(targetId);
        expect(found).toContain('2026');
    });

    it('finds rollout in older date subdir', async () => {
        const found = await findRolloutByConversationId(root, otherId);
        expect(found).not.toBeNull();
        expect(found).toContain(otherId);
    });

    it('returns null when conversationId is not found', async () => {
        const found = await findRolloutByConversationId(
            root,
            '00000000-0000-0000-0000-000000000000',
        );
        expect(found).toBeNull();
    });

    it('returns null when sessions root does not exist', async () => {
        const found = await findRolloutByConversationId('/nonexistent-root', targetId);
        expect(found).toBeNull();
    });

    it('handles case-insensitive UUID input', async () => {
        const found = await findRolloutByConversationId(root, targetId.toUpperCase());
        expect(found).not.toBeNull();
        expect(found).toContain(targetId);
    });
});
