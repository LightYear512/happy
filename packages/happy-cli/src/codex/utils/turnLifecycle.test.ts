import { describe, it, expect } from 'vitest';
import { createTurnLifecycle } from './turnLifecycle';

describe('createTurnLifecycle', () => {
    it('starts with no pending promise', () => {
        const lifecycle = createTurnLifecycle();
        expect(lifecycle.current).toBeNull();
    });

    it('begin creates a pending promise', () => {
        const lifecycle = createTurnLifecycle();
        lifecycle.begin();
        expect(lifecycle.current).not.toBeNull();
    });

    it('finish() resolves the pending promise (turn/completed exit)', async () => {
        const lifecycle = createTurnLifecycle();
        lifecycle.begin();
        const p = lifecycle.current!;
        lifecycle.finish();
        await expect(p).resolves.toBeUndefined();
        expect(lifecycle.current).toBeNull();
    });

    it('finish() resolves on turn/interrupted exit', async () => {
        const lifecycle = createTurnLifecycle();
        lifecycle.begin();
        const p = lifecycle.current!;
        lifecycle.finish(); // turn/interrupted handler does not pass an error
        await expect(p).resolves.toBeUndefined();
    });

    it('finish() resolves on error notification exit (v2 design)', async () => {
        // Critical contract: error notifications go through resolve, not reject.
        // The error is surfaced via the session event stream; the promise
        // channel only signals "settled", not "settled with error".
        const lifecycle = createTurnLifecycle();
        lifecycle.begin();
        const p = lifecycle.current!;
        lifecycle.finish(); // error handler also calls finish() with no args
        await expect(p).resolves.toBeUndefined();
    });

    it('finish(error) rejects the pending promise (turn/start RPC fail exit)', async () => {
        const lifecycle = createTurnLifecycle();
        lifecycle.begin();
        const p = lifecycle.current!;
        const err = new Error('thread/start failed');
        lifecycle.finish(err);
        await expect(p).rejects.toThrow('thread/start failed');
    });

    it('finish() is idempotent — second call is a no-op', () => {
        const lifecycle = createTurnLifecycle();
        lifecycle.begin();
        lifecycle.finish();
        // Second finish must not throw and must not re-trigger anything
        expect(() => lifecycle.finish()).not.toThrow();
        expect(() => lifecycle.finish(new Error('late'))).not.toThrow();
        expect(lifecycle.current).toBeNull();
    });

    it('finish() before begin() is a no-op (defensive)', () => {
        const lifecycle = createTurnLifecycle();
        expect(() => lifecycle.finish()).not.toThrow();
        expect(() => lifecycle.finish(new Error('whatever'))).not.toThrow();
        expect(lifecycle.current).toBeNull();
    });

    it('begin → finish → begin → finish handles back-to-back turns', async () => {
        const lifecycle = createTurnLifecycle();

        lifecycle.begin();
        const p1 = lifecycle.current!;
        lifecycle.finish();
        await p1;

        lifecycle.begin();
        const p2 = lifecycle.current!;
        expect(p2).not.toBe(p1); // distinct promise instances
        lifecycle.finish();
        await p2;
    });

    it('rejected promise does not crash repeated finish calls', async () => {
        const lifecycle = createTurnLifecycle();
        lifecycle.begin();
        const p = lifecycle.current!;
        lifecycle.finish(new Error('boom'));
        // Caller may or may not have a catch yet; second finish must still no-op
        expect(() => lifecycle.finish()).not.toThrow();
        await expect(p).rejects.toThrow('boom');
    });

    it('begin while still pending replaces the promise (turn/start late after error)', async () => {
        // Edge case: if a caller forgets to finish before begin(), the new
        // begin() drops the old promise. That promise was never settled and
        // becomes unreachable. This is documented as caller error, not
        // lifecycle responsibility. Test pins the behavior.
        const lifecycle = createTurnLifecycle();
        lifecycle.begin();
        const p1 = lifecycle.current;
        lifecycle.begin();
        const p2 = lifecycle.current;
        expect(p2).not.toBe(p1);
        lifecycle.finish();
        await expect(p2).resolves.toBeUndefined();
    });
});
