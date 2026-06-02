import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    loadFallbackCompactDocs,
    stripProjectDocs,
    PROJECT_DOCS_OPEN,
    PROJECT_DOCS_CLOSE,
    FALLBACK_DOC_DIRNAME,
    FALLBACK_DOC_FILENAME,
} from './projectFallbackDocs';

const SEED_SENTINEL = '<!--HAPPY-COMPACT-SEED-v1-->';

describe('projectFallbackDocs', () => {
    let cwd: string;

    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'happy-fbdocs-'));
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });

    async function writeDoc(content: string): Promise<void> {
        const dir = join(cwd, FALLBACK_DOC_DIRNAME);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, FALLBACK_DOC_FILENAME), content, 'utf-8');
    }

    describe('loadFallbackCompactDocs', () => {
        it('returns "" when .happy/ is absent', async () => {
            expect(await loadFallbackCompactDocs(cwd)).toBe('');
        });

        it('returns "" when the file is empty or whitespace-only', async () => {
            await writeDoc('   \n\t  \n');
            expect(await loadFallbackCompactDocs(cwd)).toBe('');
        });

        it('wraps real content in sentinels with a heading naming the file', async () => {
            await writeDoc('# 架构\n本项目用 codex app-server。');
            const out = await loadFallbackCompactDocs(cwd);
            expect(out).toContain(PROJECT_DOCS_OPEN);
            expect(out).toContain(PROJECT_DOCS_CLOSE);
            expect(out).toContain('本项目用 codex app-server。');
            expect(out).toContain(FALLBACK_DOC_FILENAME);
        });

        it('strips a leading BOM', async () => {
            await writeDoc('\\uFEFF内容X');
            const out = await loadFallbackCompactDocs(cwd);
            expect(out).toContain('内容X');
            expect(out.includes('\\uFEFF内容X')).toBe(false);
        });

        it('redacts high-confidence secrets but keeps name=value doc examples', async () => {
            await writeDoc('设置 sk-' + 'a'.repeat(24) + '\n示例: password=your_value_here');
            const out = await loadFallbackCompactDocs(cwd);
            expect(out).toContain('[REDACTED-API-KEY]');
            expect(out).toContain('password=your_value_here');
        });

        it('sanitizes a complete sentinel appearing in the body (anti-escape) and round-trips through strip', async () => {
            await writeDoc(`文档讲解了 ${PROJECT_DOCS_CLOSE} 这个标记`);
            const out = await loadFallbackCompactDocs(cwd);
            // Only the wrapping CLOSE is a real sentinel → exactly one occurrence.
            expect(out.split(PROJECT_DOCS_CLOSE).length - 1).toBe(1);
            // A full SEED-prefixed message wrapping this block strips cleanly.
            expect(stripProjectDocs(`${SEED_SENTINEL}seed${out}`)).toBe(`${SEED_SENTINEL}seed`);
        });

        it('truncates an over-long doc, balances code fences, and adds a warning', async () => {
            const big = 'intro line\n```ts\n' + 'x'.repeat(5000) + '\n```\ntail';
            await writeDoc(big);
            const out = await loadFallbackCompactDocs(cwd, 800);
            expect(out).toContain('已按行边界截断');
            expect((out.match(/```/g) ?? []).length % 2).toBe(0); // fences balanced
            expect(out.length).toBeLessThan(big.length);
        });

        it('treats non-positive / non-finite maxChars as the default cap (no slice(0,-n) tail-chop)', async () => {
            // ~800-char doc with a trailing marker — well under the 16000 default.
            const doc = '行内容\n'.repeat(200) + '末尾标记TAILMARK';
            await writeDoc(doc);
            for (const bad of [-100, 0, Number.NaN]) {
                const out = await loadFallbackCompactDocs(cwd, bad);
                // With the guard a bad cap falls back to the default → the doc
                // fits → the tail survives. Without it, slice(0,-100) would chop
                // the tail and no truncation warning would even fire.
                expect(out, `maxChars=${bad}`).toContain('末尾标记TAILMARK');
                expect(out, `maxChars=${bad}`).not.toContain('已按行边界截断');
            }
        });
    });

    describe('stripProjectDocs', () => {
        it('returns input unchanged when no sentinel present', () => {
            expect(stripProjectDocs('plain seed text')).toBe('plain seed text');
        });

        it('removes a complete docs block', () => {
            const t = `head${PROJECT_DOCS_OPEN}docs body${PROJECT_DOCS_CLOSE}tail`;
            expect(stripProjectDocs(t)).toBe('headtail');
        });

        it('removes multiple blocks', () => {
            const t = `a${PROJECT_DOCS_OPEN}1${PROJECT_DOCS_CLOSE}b${PROJECT_DOCS_OPEN}2${PROJECT_DOCS_CLOSE}c`;
            expect(stripProjectDocs(t)).toBe('abc');
        });

        it('drops to end-of-string on an unmatched OPEN (corrupted injection)', () => {
            const t = `keep${PROJECT_DOCS_OPEN}dangling docs with no close`;
            expect(stripProjectDocs(t)).toBe('keep');
        });
    });
});
