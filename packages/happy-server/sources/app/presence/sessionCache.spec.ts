import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock DB before importing — the cache does `db.session.findUnique` in its
// cache-miss path, plus the batch flush does `db.session.update`. vi.hoisted
// runs before imports so the mock factory has access to the mock instances.
const { dbMock } = vi.hoisted(() => ({
    dbMock: {
        session: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        machine: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
    },
}));

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/utils/log', () => ({ log: () => { /* noop */ } }));
vi.mock('@/app/monitoring/metrics2', () => ({
    sessionCacheCounter: { inc: vi.fn() },
    databaseUpdatesSkippedCounter: { inc: vi.fn() },
}));

import { ActivityCache } from './sessionCache';

const USER_ID = 'user-1';
const SESSION_ID = 'sess-1';

// Use a far-past lastActiveAt by default so `queueSessionUpdate` (which
// only queues if |now - lastUpdateSent| > UPDATE_THRESHOLD = 30s) consistently
// accepts present-time heartbeats in tests.
function makeSessionRow(overrides: Partial<{ id: string; active: boolean; lastActiveAt: Date }> = {}) {
    return {
        id: overrides.id ?? SESSION_ID,
        accountId: USER_ID,
        active: overrides.active ?? true,
        lastActiveAt: overrides.lastActiveAt ?? new Date(Date.now() - 10 * 60 * 1000),
    };
}

describe('ActivityCache — dead flag state machine', () => {
    let cache: ActivityCache;

    beforeEach(() => {
        vi.clearAllMocks();
        cache = new ActivityCache();
    });

    afterEach(() => {
        // Stop the internal batch timer so tests don't hang
        // (flushPendingUpdates interval runs every BATCH_INTERVAL).
        // Best-effort — internal, so cast through any.
        const anyCache = cache as any;
        if (anyCache.batchTimer) {
            clearInterval(anyCache.batchTimer);
            anyCache.batchTimer = null;
        }
    });

    describe('markSessionDead → queueSessionUpdate rejection', () => {
        it('queueSessionUpdate returns false after markSessionDead (race cut)', async () => {
            // Seed cache via isSessionValid (cache-miss path creates the entry)
            dbMock.session.findUnique.mockResolvedValueOnce(makeSessionRow({ active: true }));
            expect(await cache.isSessionValid(SESSION_ID, USER_ID)).toBe(true);

            // Entry is live — queueSessionUpdate should succeed
            const now = Date.now();
            expect(cache.queueSessionUpdate(SESSION_ID, now)).toBe(true);

            // Simulate session-end: mark dead
            cache.markSessionDead(SESSION_ID);

            // A straggler session-alive from child's lingering heartbeat must NOT queue
            expect(cache.queueSessionUpdate(SESSION_ID, now + 1000)).toBe(false);
        });

        it('isSessionValid cache-hit returns false for dead entry', async () => {
            dbMock.session.findUnique.mockResolvedValueOnce(makeSessionRow({ active: true }));
            await cache.isSessionValid(SESSION_ID, USER_ID);

            cache.markSessionDead(SESSION_ID);

            // Cache is still within TTL — hit path should short-circuit to false
            expect(await cache.isSessionValid(SESSION_ID, USER_ID)).toBe(false);
            // Should NOT have re-queried the DB (still only 1 call total)
            expect(dbMock.session.findUnique).toHaveBeenCalledTimes(1);
        });

        it('isSessionAlive returns false for dead entries', async () => {
            dbMock.session.findUnique.mockResolvedValueOnce(makeSessionRow({ active: true }));
            await cache.isSessionValid(SESSION_ID, USER_ID);
            cache.queueSessionUpdate(SESSION_ID, Date.now());
            expect(cache.isSessionAlive(SESSION_ID)).toBe(true);

            cache.markSessionDead(SESSION_ID);
            expect(cache.isSessionAlive(SESSION_ID)).toBe(false);
        });
    });

    describe('cache-miss path respects DB.active', () => {
        it('DB.active=false → entry created with dead=true, isSessionValid returns false', async () => {
            dbMock.session.findUnique.mockResolvedValueOnce(makeSessionRow({ active: false }));

            // Cache miss on cold entry
            const result = await cache.isSessionValid(SESSION_ID, USER_ID);
            expect(result).toBe(false);

            // Subsequent queueSessionUpdate must also be rejected (cache hit dead)
            expect(cache.queueSessionUpdate(SESSION_ID, Date.now())).toBe(false);
        });

        it('DB.active=true → entry created with dead=false, isSessionValid returns true', async () => {
            dbMock.session.findUnique.mockResolvedValueOnce(makeSessionRow({ active: true }));

            const result = await cache.isSessionValid(SESSION_ID, USER_ID);
            expect(result).toBe(true);

            expect(cache.queueSessionUpdate(SESSION_ID, Date.now())).toBe(true);
        });
    });

    describe('invalidateSession → full revival flow', () => {
        it('dropped entry forces DB re-fetch, picks up active=true', async () => {
            // First fetch: session is dead in DB
            dbMock.session.findUnique.mockResolvedValueOnce(makeSessionRow({ active: false }));
            expect(await cache.isSessionValid(SESSION_ID, USER_ID)).toBe(false);

            // tryRestoreSession flow: DB flipped to active=true out-of-band, cache invalidated
            cache.invalidateSession(SESSION_ID);

            // Next fetch reads DB fresh — mock now returns active=true
            dbMock.session.findUnique.mockResolvedValueOnce(makeSessionRow({ active: true }));
            expect(await cache.isSessionValid(SESSION_ID, USER_ID)).toBe(true);

            // And heartbeats are accepted again
            expect(cache.queueSessionUpdate(SESSION_ID, Date.now())).toBe(true);
        });

        it('invalidateSession on unknown id is a no-op (no throw)', () => {
            expect(() => cache.invalidateSession('nonexistent')).not.toThrow();
        });
    });

    describe('flushPendingUpdates — heartbeat ≠ lifecycle', () => {
        it('only writes lastActiveAt, never active:true (regression guard)', async () => {
            dbMock.session.findUnique.mockResolvedValueOnce(makeSessionRow({ active: true }));
            await cache.isSessionValid(SESSION_ID, USER_ID);

            const ts = Date.now();
            cache.queueSessionUpdate(SESSION_ID, ts);

            dbMock.session.update.mockResolvedValue({});

            // Drive the flush manually
            await (cache as any).flushPendingUpdates();

            expect(dbMock.session.update).toHaveBeenCalledTimes(1);
            const call = dbMock.session.update.mock.calls[0][0];
            expect(call.where).toEqual({ id: SESSION_ID });
            expect(call.data.lastActiveAt).toBeInstanceOf(Date);
            // CRITICAL: must not carry active:true — that was the bug that
            // silently resurrected sessions after session-end.
            expect(call.data).not.toHaveProperty('active');
        });

        it('does not flush dead sessions (queueSessionUpdate already rejected them)', async () => {
            dbMock.session.findUnique.mockResolvedValueOnce(makeSessionRow({ active: true }));
            await cache.isSessionValid(SESSION_ID, USER_ID);
            cache.queueSessionUpdate(SESSION_ID, Date.now());

            // Kill the session before the flush fires
            cache.markSessionDead(SESSION_ID);

            dbMock.session.update.mockResolvedValue({});
            await (cache as any).flushPendingUpdates();

            // pendingUpdate was cleared by markSessionDead → no flush
            expect(dbMock.session.update).not.toHaveBeenCalled();
        });
    });

    describe('full race scenario reproduction', () => {
        it('session-end + straggler heartbeats + flush cannot resurrect a dead session', async () => {
            // Setup: live session in cache
            dbMock.session.findUnique.mockResolvedValueOnce(makeSessionRow({ active: true }));
            await cache.isSessionValid(SESSION_ID, USER_ID);
            cache.queueSessionUpdate(SESSION_ID, Date.now());

            // 1. daemon sends session-end → markSessionDead
            cache.markSessionDead(SESSION_ID);

            // 2. Child process is still alive, sends session-alive heartbeats
            //    (what used to re-populate pendingUpdate and resurrect)
            for (let i = 0; i < 5; i++) {
                expect(cache.queueSessionUpdate(SESSION_ID, Date.now() + i * 100)).toBe(false);
            }

            // 3. Batch timer fires flushPendingUpdates
            dbMock.session.update.mockResolvedValue({});
            await (cache as any).flushPendingUpdates();

            // 4. Assert: no DB write, session stays dead
            expect(dbMock.session.update).not.toHaveBeenCalled();
            expect(cache.isSessionAlive(SESSION_ID)).toBe(false);
        });
    });
});
