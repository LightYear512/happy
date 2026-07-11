import { describe, expect, it } from 'vitest';
import {
    SessionRecoveryError,
    mergeRecoveryMessages,
    selectRecoveryMessages,
    type SessionRecoveryRow,
} from './sessionMessageRecovery';

const row = (id: string, seq: number): SessionRecoveryRow => ({
    id,
    seq,
    createdAt: 1_000 + seq,
    content: { t: 'encrypted', c: `cipher-${seq}` },
});

describe('session message recovery', () => {
    it('HSR selects messages after the exact anchor in server sequence order', () => {
        const selected = selectRecoveryMessages(
            [row('m-12', 12), row('m-10', 10), row('m-11', 11)],
            { id: 'm-10', seq: 10 },
        );
        expect(selected.map((item) => item.id)).toEqual(['m-11', 'm-12']);
    });

    it('HSR deduplicates identical query and live-buffer rows while preserving order', () => {
        const merged = mergeRecoveryMessages(
            [row('m-11', 11), row('m-12', 12)],
            [row('m-12', 12), row('m-13', 13)],
        );
        expect(merged.map((item) => item.id)).toEqual(['m-11', 'm-12', 'm-13']);
    });

    it('HSR fails closed when the full recent window cannot prove anchor continuity', () => {
        const rows = Array.from({ length: 150 }, (_, index) => row(`m-${index + 20}`, index + 20));
        expect(() => selectRecoveryMessages(rows, { id: 'm-10', seq: 10 }))
            .toThrowError(SessionRecoveryError);
        expect(() => selectRecoveryMessages(rows, { id: null, seq: 10 }))
            .toThrow(/recovery_incomplete/);
    });

    it('HSR permits a sequence-only anchor only when the recent query is provably complete', () => {
        expect(selectRecoveryMessages([row('m-11', 11), row('m-12', 12)], { id: null, seq: 10 }))
            .toEqual([row('m-11', 11), row('m-12', 12)]);
    });

    it('HSR rejects malformed or conflicting recovery rows', () => {
        expect(() => selectRecoveryMessages([{ ...row('m-11', 11), seq: 0 }], { id: null, seq: 10 }))
            .toThrow(/recovery_incomplete/);
        expect(() => mergeRecoveryMessages([row('same', 11)], [row('same', 12)]))
            .toThrow(/recovery_incomplete/);
    });

    it('HSR rejects a query larger than the deployed recent-message window', () => {
        const rows = Array.from({ length: 151 }, (_, index) => row(`m-${index + 1}`, index + 1));
        expect(() => selectRecoveryMessages(rows, { id: null, seq: 0 })).toThrow(/oversized/);
    });

    it('HSR rejects an encrypted row larger than the recovery byte budget', () => {
        const oversized = { ...row('m-1', 1), content: { t: 'encrypted' as const, c: 'x'.repeat(4 * 1024 * 1024 + 1) } };
        expect(() => selectRecoveryMessages([oversized], { id: null, seq: 0 }))
            .toThrow(/content is invalid/);
    });
});
