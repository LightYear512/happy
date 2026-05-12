import { describe, it, expect } from 'vitest';
import {
    createRecentUserBuffer,
    DEFAULT_RECENT_USER_TEXT_CAP,
} from './recentUserBuffer';

describe('createRecentUserBuffer', () => {
    it('rejects empty / non-string input without throwing', () => {
        const b = createRecentUserBuffer(8);
        b.record('');
        b.record(undefined as unknown as string);
        b.record(null as unknown as string);
        b.record(0 as unknown as string);
        b.record({} as unknown as string);
        expect(b.snapshot()).toEqual([]);
    });

    it('preserves insertion order under the cap', () => {
        const b = createRecentUserBuffer(8);
        b.record('a');
        b.record('b');
        b.record('c');
        expect(b.snapshot()).toEqual(['a', 'b', 'c']);
    });

    it('evicts oldest entries on overflow (FIFO)', () => {
        const b = createRecentUserBuffer(3);
        b.record('a');
        b.record('b');
        b.record('c');
        b.record('d');
        b.record('e');
        expect(b.snapshot()).toEqual(['c', 'd', 'e']);
    });

    it('snapshot returns a copy — caller mutation does not affect buffer', () => {
        const b = createRecentUserBuffer(4);
        b.record('x');
        b.record('y');
        const snap = b.snapshot();
        snap.push('rogue');
        snap[0] = 'tampered';
        expect(b.snapshot()).toEqual(['x', 'y']);
    });

    it('clear() drops all entries and lets new records start fresh', () => {
        const b = createRecentUserBuffer(8);
        b.record('a');
        b.record('b');
        b.record('c');
        b.clear();
        expect(b.snapshot()).toEqual([]);
        b.record('d');
        expect(b.snapshot()).toEqual(['d']);
    });

    it('default cap is the documented constant', () => {
        expect(DEFAULT_RECENT_USER_TEXT_CAP).toBe(8);
        const b = createRecentUserBuffer(); // use default
        for (let i = 0; i < 20; i++) b.record(`msg-${i}`);
        expect(b.snapshot()).toHaveLength(DEFAULT_RECENT_USER_TEXT_CAP);
        expect(b.snapshot()[0]).toBe('msg-12'); // 20 - 8
        expect(b.snapshot()[7]).toBe('msg-19');
    });

    it('cap = 1 keeps only the newest entry', () => {
        const b = createRecentUserBuffer(1);
        b.record('a');
        expect(b.snapshot()).toEqual(['a']);
        b.record('b');
        expect(b.snapshot()).toEqual(['b']);
        b.record('c');
        expect(b.snapshot()).toEqual(['c']);
    });

    it('cap = 1 with clear() between records behaves like an empty buffer', () => {
        const b = createRecentUserBuffer(1);
        b.record('a');
        b.clear();
        expect(b.snapshot()).toEqual([]);
        b.record('b');
        expect(b.snapshot()).toEqual(['b']);
    });

    it('separate instances are independent', () => {
        const a = createRecentUserBuffer(4);
        const b = createRecentUserBuffer(4);
        a.record('a-only');
        b.record('b-only');
        expect(a.snapshot()).toEqual(['a-only']);
        expect(b.snapshot()).toEqual(['b-only']);
        a.clear();
        expect(a.snapshot()).toEqual([]);
        expect(b.snapshot()).toEqual(['b-only']);
    });
});
