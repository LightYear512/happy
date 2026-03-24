import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { handleOpenBangCommand } from './openCommand';
import type { BangCommandContext } from './types';

/**
 * Create a test session JSONL file in a temp Claude config directory.
 */
async function createTestSession(
    baseDir: string,
    projectName: string,
    sessionId: string,
    cwd: string,
    firstMessage: string
): Promise<void> {
    const projectDir = join(baseDir, 'projects', projectName);
    await mkdir(projectDir, { recursive: true });
    const filePath = join(projectDir, `${sessionId}.jsonl`);
    const lines = [
        JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: firstMessage, sessionId, padding: 'x'.repeat(100) }),
        JSON.stringify({ cwd, sessionId, type: 'progress', data: {} }),
    ];
    await writeFile(filePath, lines.join('\n') + '\n', 'utf-8');
}

/** Minimal mock context — bang commands only use client.sendSessionEvent */
function createMockContext(): BangCommandContext {
    return {
        client: { sendSessionEvent: () => {} } as any,
        session: null,
        messageQueue: {} as any,
        currentEnhancedMode: { permissionMode: 'default' } as any,
    };
}

/** Flatten result.message (string or string[]) into a single string for assertion */
function flatMsg(message: string | string[]): string {
    return Array.isArray(message) ? message.join('\n') : message;
}

describe('handleOpenBangCommand', () => {
    let tempDir: string;
    const originalEnv = process.env.CLAUDE_CONFIG_DIR;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'happy-resume-test-'));
        process.env.CLAUDE_CONFIG_DIR = tempDir;
    });

    afterEach(async () => {
        process.env.CLAUDE_CONFIG_DIR = originalEnv;
        await rm(tempDir, { recursive: true, force: true });
    });

    it('shows usage or empty message when no args provided', async () => {
        const result = await handleOpenBangCommand('', createMockContext());
        expect(result.action).toBe('none');
        // May show usage hint or "no sessions" message
        const msg = flatMsg(result.message);
        expect(msg.length).toBeGreaterThan(0);
    });

    it('returns error when no session matches prefix', async () => {
        const result = await handleOpenBangCommand('zzzzz', createMockContext());
        expect(result.action).toBe('none');
        const msg = flatMsg(result.message);
        expect(msg).toMatch(/未找到|not found/i);
    });

    it('returns ambiguity error when multiple sessions match', async () => {
        await createTestSession(tempDir, 'C--test', 'aabbccdd-1111-2222-3333-444444444444', '/test', 'msg1');
        await createTestSession(tempDir, 'C--test', 'aabbccdd-2222-3333-4444-555555555555', '/test', 'msg2');

        const result = await handleOpenBangCommand('aabbccdd', createMockContext());
        expect(result.action).toBe('none');
        const msg = flatMsg(result.message);
        expect(msg).toMatch(/匹配了 2 个|2 matches/i);
    });

    it('rejects session with no cwd', async () => {
        // Create session without cwd line
        const projectDir = join(tempDir, 'projects', 'C--nocwd');
        await mkdir(projectDir, { recursive: true });
        await writeFile(
            join(projectDir, 'aabbccdd-3333-4444-5555-666666666666.jsonl'),
            JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'hello', sessionId: 'x', padding: 'x'.repeat(100) }) + '\n',
            'utf-8'
        );

        const result = await handleOpenBangCommand('aabbccdd-3333', createMockContext());
        expect(result.action).toBe('none');
        const msg = flatMsg(result.message);
        expect(msg).toMatch(/缺少工作目录|no cwd|missing/i);
    });

    it('attempts to spawn session when single match with cwd found', async () => {
        await createTestSession(tempDir, 'C--proj', 'ffaabbcc-1111-2222-3333-444444444444', '/home/user/proj', 'test msg');

        // This will fail to connect to daemon (not running in test), but we verify
        // the command correctly identifies the session and attempts spawn
        const result = await handleOpenBangCommand('ffaabbcc', createMockContext());
        expect(result.action).toBe('none');
        const msg = flatMsg(result.message);
        // Either success message or daemon connection error — both prove the session was matched
        expect(msg).toMatch(/打开会话|打开会话失败|spawn|open/i);
    });
});
