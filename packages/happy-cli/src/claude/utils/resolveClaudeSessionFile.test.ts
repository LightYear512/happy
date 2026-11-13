import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectPath } from './path';
import { resolveClaudeSessionFile } from './resolveClaudeSessionFile';
import { claudeCheckSession } from './claudeCheckSession';

describe('explicit Claude resume after changing workspace', () => {
    const id = 'b0c911f6-de42-4e28-b742-5869f31ccc8d';
    let root: string;
    let originalConfig: string | undefined;
    let oldWorkspace: string;
    let newWorkspace: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'happy-resume-workspace-'));
        originalConfig = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = join(root, 'account');
        oldWorkspace = join(root, 'home');
        newWorkspace = join(oldWorkspace, 'project');
    });

    afterEach(() => {
        if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = originalConfig;
        rmSync(root, { recursive: true, force: true });
    });

    function transcript(workspace: string, content = JSON.stringify({ type: 'user', uuid: 'message-1' })) {
        const directory = getProjectPath(workspace);
        mkdirSync(directory, { recursive: true });
        const file = join(directory, `${id}.jsonl`);
        writeFileSync(file, content);
        return file;
    }

    it('resumes the unique original transcript without moving or copying it', () => {
        const original = transcript(oldWorkspace);
        expect(resolveClaudeSessionFile(id, newWorkspace)).toBe(original);
        expect(claudeCheckSession(id, newWorkspace)).toBe(true);
    });

    it('rejects ambiguous cross-project histories, but prefers an exact current-project file', () => {
        transcript(oldWorkspace);
        transcript(join(root, 'another-project'));
        expect(resolveClaudeSessionFile(id, newWorkspace)).toBeNull();
        expect(claudeCheckSession(id, newWorkspace)).toBe(false);
        const current = transcript(newWorkspace);
        expect(resolveClaudeSessionFile(id, newWorkspace)).toBe(current);
    });

    it('keeps account isolation and rejects missing histories', () => {
        transcript(oldWorkspace);
        process.env.CLAUDE_CONFIG_DIR = join(root, 'other-account');
        expect(resolveClaudeSessionFile(id, newWorkspace)).toBeNull();
        expect(claudeCheckSession(id, newWorkspace)).toBe(false);
    });

    it('does not turn an empty or malformed transcript into a new conversation', () => {
        transcript(oldWorkspace, '');
        expect(claudeCheckSession(id, newWorkspace)).toBe(false);
        transcript(oldWorkspace, '{broken\n{"uuid":""}\n');
        expect(claudeCheckSession(id, newWorkspace)).toBe(false);
    });

    it('rejects non UUID and path inputs', () => {
        transcript(oldWorkspace);
        for (const candidate of ['../' + id, '', 'latest', id + '/child']) {
            expect(resolveClaudeSessionFile(candidate, newWorkspace)).toBeNull();
        }
    });

    it('does not accept linked project children that native cross-project discovery skips', () => {
        const projects = join(process.env.CLAUDE_CONFIG_DIR!, 'projects');
        const elsewhere = join(root, 'outside-projects');
        mkdirSync(projects, { recursive: true });
        mkdirSync(elsewhere);
        writeFileSync(join(elsewhere, `${id}.jsonl`), JSON.stringify({ uuid: 'message-1' }));
        symlinkSync(elsewhere, join(projects, 'linked-project'), 'dir');
        expect(resolveClaudeSessionFile(id, newWorkspace)).toBeNull();
    });
});
