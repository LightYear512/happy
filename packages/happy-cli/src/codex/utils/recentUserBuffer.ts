/**
 * Bounded ring buffer of recently-accepted user prompts.
 *
 * Sole purpose: race recovery for /compact. The seed builder reads codex's
 * rollout.jsonl on disk, but codex writes user prompts to rollout
 * asynchronously, so an auto-rescue /compact firing too soon after a fresh
 * prompt can scan a rollout that does not yet contain it. We mirror every
 * accepted prompt into this in-memory ring and pass a snapshot to the seed
 * builder as `extraUserTexts`, which splices them in regardless of rollout
 * flush timing.
 *
 * Industry parallel: same staleness-reconciliation pattern as
 *   - Kafka producer's `RecordAccumulator` (in-memory batch before broker ack)
 *   - systemd-journald's runtime ring buffer (before persisting to journal)
 *   - Git's index file (staging-area SSoT before commit reconciles to packfile)
 * In each case the durable store lags an in-memory authoritative view; on
 * checkpoint events both sources must be reconciled.
 *
 * Lifecycle: caller must `clear()` on every successful thread swap, since the
 * prior thread's prompts are by then either baked into the just-emitted seed
 * or unrecoverable. Keeping them around would inject already-summarised
 * content into future seeds, undoing SEED_SENTINEL's discard-older invariant.
 */

export interface RecentUserBuffer {
    /** Append a prompt. Silently ignores empty / non-string input. */
    record: (text: string) => void;
    /** Frozen-in-time copy — mutating the result does not affect the buffer. */
    snapshot: () => string[];
    /** Drop all entries. Use on thread swap. */
    clear: () => void;
}

/**
 * Cap rationale: 8 entries covers realistic burst patterns (user pasting a
 * multi-line script, fast follow-ups before the model responds). Beyond ~8
 * the issue is no longer rollout-flush latency — it's the turn loop itself
 * not draining, which this buffer cannot solve and FIFO eviction will not
 * lose correctness on (oldest is most likely already flushed to rollout).
 */
export const DEFAULT_RECENT_USER_TEXT_CAP = 8;

export function createRecentUserBuffer(
    cap: number = DEFAULT_RECENT_USER_TEXT_CAP,
): RecentUserBuffer {
    const buf: string[] = [];
    return {
        record(text: string): void {
            if (typeof text !== 'string' || text.length === 0) return;
            buf.push(text);
            if (buf.length > cap) buf.shift();
        },
        snapshot(): string[] {
            return [...buf];
        },
        clear(): void {
            buf.length = 0;
        },
    };
}
