import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { isCuid } from '@paralleldrive/cuid2';
import { readThreadId, readTurnId } from '../runCodexAppServer';
import { createAppServerStreamBridge, type AppServerStreamUpdate } from '../appServerStreamBridge';
import { logger } from '@/ui/logger';

// Regression suite for codex 0.130.0 protocol drift: notifications switched
// from camelCase `turnId` / `threadId` to snake_case `turn_id` / `thread_id`.
// Before the fix, the reader fell back to a fabricated local CUID, which
// codex rejected when sent back as `turn/interrupt`'s `turnId` param — the
// app-side stop button silently failed.

describe('readThreadId', () => {
    it('reads camelCase top-level threadId', () => {
        expect(readThreadId({ threadId: 'thr-1' })).toBe('thr-1');
    });

    it('reads snake_case top-level thread_id (codex 0.130.0 form)', () => {
        expect(readThreadId({ thread_id: 'thr-2' })).toBe('thr-2');
    });

    it('reads nested thread.id', () => {
        expect(readThreadId({ thread: { id: 'thr-3' } })).toBe('thr-3');
    });

    it('reads nested thread.thread_id (defensive against future drift)', () => {
        expect(readThreadId({ thread: { thread_id: 'thr-4' } })).toBe('thr-4');
    });

    it('returns null when no candidate matches', () => {
        expect(readThreadId({ foo: 'bar' })).toBeNull();
        expect(readThreadId({})).toBeNull();
        expect(readThreadId(null)).toBeNull();
        expect(readThreadId(undefined)).toBeNull();
    });

    it('trims whitespace', () => {
        expect(readThreadId({ thread_id: '  thr-5  ' })).toBe('thr-5');
    });

    it('skips empty strings and falls through to next candidate', () => {
        expect(readThreadId({ threadId: '', thread_id: 'thr-6' })).toBe('thr-6');
    });
});

describe('readTurnId', () => {
    it('reads camelCase top-level turnId', () => {
        expect(readTurnId({ turnId: 'turn-1' })).toBe('turn-1');
    });

    it('reads snake_case top-level turn_id (codex 0.130.0 form)', () => {
        expect(readTurnId({ turn_id: 'turn-2' })).toBe('turn-2');
    });

    it('reads nested turn.id (turn/start RPC response form)', () => {
        expect(readTurnId({ turn: { id: 'turn-3' } })).toBe('turn-3');
    });

    it('reads nested turn.turn_id (defensive against future drift)', () => {
        expect(readTurnId({ turn: { turn_id: 'turn-4' } })).toBe('turn-4');
    });

    it('returns null when no candidate matches', () => {
        expect(readTurnId({ foo: 'bar' })).toBeNull();
        expect(readTurnId({})).toBeNull();
        expect(readTurnId(null)).toBeNull();
    });

    it('prefers camelCase over snake_case when both present (back-compat)', () => {
        // Codex is migrating; during the transition, both may coexist. We
        // prefer camelCase only because that was the historical contract —
        // either should work identically since they represent the same id.
        expect(readTurnId({ turnId: 'cam', turn_id: 'snake' })).toBe('cam');
    });
});

describe('createAppServerStreamBridge.turn/started', () => {
    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    });

    afterEach(() => {
        debugSpy.mockRestore();
    });

    function pickTaskStartedTurnId(updates: AppServerStreamUpdate[]): string | null {
        const taskStarted = updates.find(u => u.type === 'task-started');
        if (!taskStarted || taskStarted.type !== 'task-started') return null;
        return taskStarted.turnId;
    }

    it('emits the real turn_id (snake_case) without fabricating a local CUID', () => {
        const bridge = createAppServerStreamBridge();
        const updates = bridge.onNotification('turn/started', { turn_id: 'real-turn-snake' });
        expect(pickTaskStartedTurnId(updates)).toBe('real-turn-snake');
        // No fallback marker means we never reached the createId() branch.
        const fallbackLog = debugSpy.mock.calls.find(
            ([msg]) => typeof msg === 'string' && msg.includes('[WARN turn_id_fallback]'),
        );
        expect(fallbackLog).toBeUndefined();
    });

    it('emits the real turnId (camelCase) for back-compat', () => {
        const bridge = createAppServerStreamBridge();
        const updates = bridge.onNotification('turn/started', { turnId: 'real-turn-camel' });
        expect(pickTaskStartedTurnId(updates)).toBe('real-turn-camel');
    });

    it('falls back to id when neither turnId nor turn_id present', () => {
        const bridge = createAppServerStreamBridge();
        const updates = bridge.onNotification('turn/started', { id: 'real-turn-via-id' });
        expect(pickTaskStartedTurnId(updates)).toBe('real-turn-via-id');
    });

    it('logs [WARN turn_id_fallback] when all candidates miss, before fabricating', () => {
        const bridge = createAppServerStreamBridge();
        const updates = bridge.onNotification('turn/started', { somethingElse: 'no-id-here' });
        const fabricated = pickTaskStartedTurnId(updates);
        expect(fabricated).not.toBeNull();
        expect(isCuid(fabricated!)).toBe(true);
        // The whole point of this regression: the fallback path must surface
        // a record-keys diagnostic so future protocol drift is observable.
        const fallbackLog = debugSpy.mock.calls.find(
            ([msg]) => typeof msg === 'string' && msg.includes('[WARN turn_id_fallback]'),
        );
        expect(fallbackLog).toBeDefined();
        expect(String(fallbackLog?.[0])).toContain('somethingElse');
    });

    it('subsequent turn/completed reuses the resolved turn_id (state carry)', () => {
        const bridge = createAppServerStreamBridge();
        bridge.onNotification('turn/started', { turn_id: 'real-turn-state' });
        const completed = bridge.onNotification('turn/completed', { status: 'completed' });
        const envelope = completed.find(u => u.type === 'envelope');
        expect(envelope).toBeDefined();
        if (envelope && envelope.type === 'envelope') {
            expect(envelope.envelope.turn).toBe('real-turn-state');
        }
    });
});
