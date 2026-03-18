import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { scanClaudeSessions, type ClaudeSessionInfo } from './sessionsCommand';

/**
 * Helper: create a JSONL session file with given lines in a temp projects dir.
 * Returns { projectsDir, filePath, sessionId }.
 */
async function createTestSession(
    baseDir: string,
    projectName: string,
    sessionId: string,
    lines: string[]
): Promise<string> {
    const projectDir = join(baseDir, 'projects', projectName);
    await mkdir(projectDir, { recursive: true });
    const filePath = join(projectDir, `${sessionId}.jsonl`);
    await writeFile(filePath, lines.join('\n') + '\n', 'utf-8');
    return filePath;
}

describe('extractSessionPreview (via scanClaudeSessions)', () => {
    let tempDir: string;
    const originalEnv = process.env.CLAUDE_CONFIG_DIR;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'happy-sessions-test-'));
        process.env.CLAUDE_CONFIG_DIR = tempDir;
    });

    afterEach(async () => {
        process.env.CLAUDE_CONFIG_DIR = originalEnv;
        await rm(tempDir, { recursive: true, force: true });
    });

    it('extracts cwd and firstMessage from queue-operation format', async () => {
        await createTestSession(tempDir, 'C--Users-test', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', [
            '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-03-11T08:18:26.114Z","sessionId":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","content":"hello world"}',
            '{"parentUuid":null,"cwd":"C:\\\\Users\\\\test","sessionId":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","type":"progress","data":{}}',
        ]);

        const sessions = await scanClaudeSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].firstMessage).toBe('hello world');
        expect(sessions[0].cwd).toBe('C:\\Users\\test');
        expect(sessions[0].sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('extracts firstMessage from user message format', async () => {
        await createTestSession(tempDir, 'C--Users-test2', 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', [
            '{"cwd":"/home/user","sessionId":"bbbbbbbb-cccc-dddd-eeee-ffffffffffff","message":{"role":"user","content":[{"type":"text","text":"explain this code"}]},"type":"progress"}',
        ]);

        const sessions = await scanClaudeSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].firstMessage).toBe('explain this code');
        expect(sessions[0].cwd).toBe('/home/user');
    });

    it('skips tiny files (< 50 bytes)', async () => {
        await createTestSession(tempDir, 'C--tiny', 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa', [
            '{"small":true}',
        ]);

        const sessions = await scanClaudeSessions();
        expect(sessions).toHaveLength(0);
    });

    it('handles corrupted JSONL lines gracefully', async () => {
        await createTestSession(tempDir, 'C--corrupt', 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb', [
            'not valid json at all',
            '{"also broken',
            '{"type":"queue-operation","operation":"enqueue","content":"found it","sessionId":"dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb"}',
            '{"cwd":"/good/path","sessionId":"dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb"}',
        ]);

        const sessions = await scanClaudeSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].firstMessage).toBe('found it');
        expect(sessions[0].cwd).toBe('/good/path');
    });

    it('returns null cwd and firstMessage when not present', async () => {
        await createTestSession(tempDir, 'C--empty', 'eeeeeeee-ffff-aaaa-bbbb-cccccccccccc', [
            '{"type":"progress","data":{"something":"else"},"padding":"' + 'x'.repeat(100) + '"}',
        ]);

        const sessions = await scanClaudeSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].cwd).toBeNull();
        expect(sessions[0].firstMessage).toBeNull();
    });

    it('sorts sessions by mtime descending', async () => {
        await createTestSession(tempDir, 'C--proj', 'aaaaaaaa-1111-2222-3333-444444444444', [
            '{"type":"queue-operation","operation":"enqueue","content":"older","sessionId":"a","padding":"' + 'x'.repeat(100) + '"}',
        ]);

        // Small delay to ensure different mtime
        await new Promise(r => setTimeout(r, 50));

        await createTestSession(tempDir, 'C--proj', 'bbbbbbbb-1111-2222-3333-444444444444', [
            '{"type":"queue-operation","operation":"enqueue","content":"newer","sessionId":"b","padding":"' + 'x'.repeat(100) + '"}',
        ]);

        const sessions = await scanClaudeSessions();
        expect(sessions).toHaveLength(2);
        expect(sessions[0].firstMessage).toBe('newer');
        expect(sessions[1].firstMessage).toBe('older');
    });

    it('scans across multiple project directories', async () => {
        await createTestSession(tempDir, 'C--proj-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', [
            '{"type":"queue-operation","operation":"enqueue","content":"from A","sessionId":"a","padding":"' + 'x'.repeat(100) + '"}',
        ]);
        await createTestSession(tempDir, 'C--proj-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', [
            '{"type":"queue-operation","operation":"enqueue","content":"from B","sessionId":"b","padding":"' + 'x'.repeat(100) + '"}',
        ]);

        const sessions = await scanClaudeSessions();
        expect(sessions).toHaveLength(2);
        const messages = sessions.map(s => s.firstMessage);
        expect(messages).toContain('from A');
        expect(messages).toContain('from B');
    });

    it('returns empty array when projects dir does not exist', async () => {
        process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'nonexistent');
        const sessions = await scanClaudeSessions();
        expect(sessions).toHaveLength(0);
    });
});

describe('UUID validation in spawnSession', () => {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    it('accepts valid UUIDs', () => {
        expect(UUID_REGEX.test('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true);
        expect(UUID_REGEX.test('017c75be-2919-4f9d-bee2-8895831f0af8')).toBe(true);
        expect(UUID_REGEX.test('AABBCCDD-1122-3344-5566-778899AABBCC')).toBe(true);
    });

    it('rejects injection attempts', () => {
        expect(UUID_REGEX.test('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee; rm -rf /')).toBe(false);
        expect(UUID_REGEX.test('$(malicious)')).toBe(false);
        expect(UUID_REGEX.test('`id`')).toBe(false);
        expect(UUID_REGEX.test('')).toBe(false);
        expect(UUID_REGEX.test('not-a-uuid')).toBe(false);
        expect(UUID_REGEX.test('aaaaaaaa-bbbb-cccc-dddd')).toBe(false);
    });
});
