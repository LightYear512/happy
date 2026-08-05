import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tx, afterTxMock } = vi.hoisted(() => ({
    tx: {
        session: { findFirst: vi.fn(), delete: vi.fn() },
        sessionMessage: { deleteMany: vi.fn() },
        usageReport: { deleteMany: vi.fn() },
        accessKey: { deleteMany: vi.fn() },
    },
    afterTxMock: vi.fn(),
}));

vi.mock('@/storage/inTx', () => ({
    inTx: vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx)),
    afterTx: afterTxMock,
}));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitUpdate: vi.fn() }, buildDeleteSessionUpdate: vi.fn(),
}));
vi.mock('@/storage/seq', () => ({ allocateUserSeq: vi.fn() }));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'key') }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import { sessionDelete } from './sessionDelete';

const old = new Date(1_000), before = new Date(2_000);

describe('sessionDelete conditional retention boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        tx.session.findFirst.mockResolvedValue({ id: 'session-1', accountId: 'account-1', active: false, lastActiveAt: old });
        tx.sessionMessage.deleteMany.mockResolvedValue({ count: 1 });
        tx.usageReport.deleteMany.mockResolvedValue({ count: 1 });
        tx.accessKey.deleteMany.mockResolvedValue({ count: 1 });
        tx.session.delete.mockResolvedValue({});
    });

    it('deletes only the matching inactive session older than the cutoff', async () => {
        await expect(sessionDelete({ uid: 'account-1' }, 'session-1',
            { expectedAccountId: 'account-1', before })).resolves.toBe('deleted');
        expect(tx.session.delete).toHaveBeenCalledWith({ where: { id: 'session-1' } });
    });

    it.each([
        ['account mismatch', { uid: 'account-2', active: false, lastActiveAt: old }],
        ['active session', { uid: 'account-1', active: true, lastActiveAt: old }],
        ['recent session', { uid: 'account-1', active: false, lastActiveAt: before }],
    ])('rejects %s without deleting related data', async (_label, value) => {
        tx.session.findFirst.mockResolvedValue({ id: 'session-1', accountId: 'account-1',
            active: value.active, lastActiveAt: value.lastActiveAt });
        await expect(sessionDelete({ uid: value.uid }, 'session-1',
            { expectedAccountId: 'account-1', before })).resolves.toBe('precondition-failed');
        expect(tx.sessionMessage.deleteMany).not.toHaveBeenCalled();
        expect(tx.session.delete).not.toHaveBeenCalled();
    });

    it('returns not-found without deleting related data', async () => {
        tx.session.findFirst.mockResolvedValue(null);
        await expect(sessionDelete({ uid: 'account-1' }, 'missing',
            { expectedAccountId: 'account-1', before })).resolves.toBe('not-found');
        expect(tx.sessionMessage.deleteMany).not.toHaveBeenCalled();
    });
});
