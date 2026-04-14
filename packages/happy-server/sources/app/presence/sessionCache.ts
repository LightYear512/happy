import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { sessionCacheCounter, databaseUpdatesSkippedCounter } from "@/app/monitoring/metrics2";

interface SessionCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
    /**
     * Set by markSessionDead when a session-end event is processed. Blocks
     * subsequent queueSessionUpdate calls (from lingering session-alive
     * heartbeats of a child process that hasn't exited yet) from resurrecting
     * the session via the batch flush path. Cleared on explicit revalidation.
     */
    dead?: boolean;
}

interface MachineCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
}

export class ActivityCache {
    private sessionCache = new Map<string, SessionCacheEntry>();
    private machineCache = new Map<string, MachineCacheEntry>();
    private batchTimer: NodeJS.Timeout | null = null;
    
    // Cache TTL (30 seconds)
    private readonly CACHE_TTL = 30 * 1000;
    
    // Only update DB if time difference is significant (30 seconds)
    private readonly UPDATE_THRESHOLD = 30 * 1000;
    
    // Batch update interval (5 seconds)
    private readonly BATCH_INTERVAL = 5 * 1000;

    constructor() {
        this.startBatchTimer();
    }

    private startBatchTimer(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
        }
        
        this.batchTimer = setInterval(() => {
            this.flushPendingUpdates().catch(error => {
                log({ module: 'session-cache', level: 'error' }, `Error flushing updates: ${error}`);
            });
        }, this.BATCH_INTERVAL);
    }

    async isSessionValid(sessionId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        const cached = this.sessionCache.get(sessionId);

        // Cache hit within TTL — short-circuit. A dead entry returns false
        // directly so a straggler session-alive from a child that hasn't exited
        // yet cannot sneak through the DB refetch path and resurrect the
        // session. The TTL (CACHE_TTL) bounds how long the dead flag sticks;
        // afterwards the next call falls through to the DB and respects
        // whatever `active` state the session is in at that point.
        if (cached && cached.validUntil > now && cached.userId === userId) {
            sessionCacheCounter.inc({ operation: 'session_validation', result: 'hit' });
            return !cached.dead;
        }

        sessionCacheCounter.inc({ operation: 'session_validation', result: 'miss' });

        // Cache miss - check database
        try {
            const session = await db.session.findUnique({
                where: { id: sessionId, accountId: userId }
            });

            if (session) {
                // Cache the result, respecting the DB's `active` flag. A session
                // that was explicitly ended (active=false) must be reflected as
                // `dead: true` in the cache, otherwise stragglers from a child's
                // lingering session-alive heartbeats would revalidate and
                // resurrect it via the ephemeral broadcast path.
                const dead = !session.active;
                this.sessionCache.set(sessionId, {
                    validUntil: now + this.CACHE_TTL,
                    lastUpdateSent: session.lastActiveAt.getTime(),
                    pendingUpdate: null,
                    userId,
                    dead
                });
                return session.active;
            }

            return false;
        } catch (error) {
            log({ module: 'session-cache', level: 'error' }, `Error validating session ${sessionId}: ${error}`);
            return false;
        }
    }

    async isMachineValid(machineId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        const cached = this.machineCache.get(machineId);
        
        // Check cache first
        if (cached && cached.validUntil > now && cached.userId === userId) {
            sessionCacheCounter.inc({ operation: 'machine_validation', result: 'hit' });
            return true;
        }
        
        sessionCacheCounter.inc({ operation: 'machine_validation', result: 'miss' });
        
        // Cache miss - check database
        try {
            const machine = await db.machine.findUnique({
                where: {
                    accountId_id: {
                        accountId: userId,
                        id: machineId
                    }
                }
            });
            
            if (machine) {
                // Cache the result
                this.machineCache.set(machineId, {
                    validUntil: now + this.CACHE_TTL,
                    lastUpdateSent: machine.lastActiveAt?.getTime() || 0,
                    pendingUpdate: null,
                    userId
                });
                return true;
            }
            
            return false;
        } catch (error) {
            log({ module: 'session-cache', level: 'error' }, `Error validating machine ${machineId}: ${error}`);
            return false;
        }
    }

    /**
     * Check if a session has received a recent heartbeat (pending or flushed within threshold).
     * Used by tryRestoreSession to avoid restoring sessions that are actually alive
     * but whose active status hasn't been flushed to DB yet.
     */
    isSessionAlive(sessionId: string): boolean {
        const cached = this.sessionCache.get(sessionId);
        if (!cached) return false;
        if (cached.dead) return false;
        // Has a pending heartbeat waiting to flush → session is alive
        if (cached.pendingUpdate) return true;
        // Last flushed heartbeat was recent (within batch interval + threshold margin)
        const recency = Date.now() - cached.lastUpdateSent;
        return recency < this.BATCH_INTERVAL + this.UPDATE_THRESHOLD;
    }

    /**
     * Mark a session as dead in the cache so isSessionAlive() returns false immediately.
     * Called when session-end is received, to avoid blocking tryRestoreSession
     * for up to 35s while the cache entry is still considered "recent".
     */
    markSessionDead(sessionId: string): void {
        const cached = this.sessionCache.get(sessionId);
        if (cached) {
            cached.pendingUpdate = null;
            cached.lastUpdateSent = 0;
            cached.dead = true;
        }
    }

    /**
     * Drop the cache entry entirely so the next isSessionValid call re-fetches
     * from the DB and picks up any out-of-band state changes (e.g. an explicit
     * tryRestoreSession that just flipped `active` back to true). Callers that
     * know the session state changed under their feet should invoke this.
     */
    invalidateSession(sessionId: string): void {
        this.sessionCache.delete(sessionId);
    }

    queueSessionUpdate(sessionId: string, timestamp: number): boolean {
        const cached = this.sessionCache.get(sessionId);
        if (!cached) {
            return false; // Should validate first
        }
        if (cached.dead) {
            // Session was explicitly ended. Refuse stragglers from the child's
            // lingering session-alive heartbeats so the batch flush can't
            // resurrect it via lastActiveAt bump.
            return false;
        }

        // Only queue if time difference is significant
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }

        databaseUpdatesSkippedCounter.inc({ type: 'session' });
        return false; // No update needed
    }

    queueMachineUpdate(machineId: string, timestamp: number): boolean {
        const cached = this.machineCache.get(machineId);
        if (!cached) {
            return false; // Should validate first
        }
        
        // Only queue if time difference is significant
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }
        
        databaseUpdatesSkippedCounter.inc({ type: 'machine' });
        return false; // No update needed
    }

    private async flushPendingUpdates(): Promise<void> {
        const sessionUpdates: { id: string, timestamp: number }[] = [];
        const machineUpdates: { id: string, timestamp: number, userId: string }[] = [];
        
        // Collect session updates
        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.pendingUpdate) {
                sessionUpdates.push({ id: sessionId, timestamp: entry.pendingUpdate });
                entry.lastUpdateSent = entry.pendingUpdate;
                entry.pendingUpdate = null;
            }
        }
        
        // Collect machine updates
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.pendingUpdate) {
                machineUpdates.push({ 
                    id: machineId, 
                    timestamp: entry.pendingUpdate, 
                    userId: entry.userId 
                });
                entry.lastUpdateSent = entry.pendingUpdate;
                entry.pendingUpdate = null;
            }
        }
        
        // Batch update sessions
        //
        // IMPORTANT: only update `lastActiveAt` here. This is a heartbeat flush;
        // `active` is lifecycle state owned by session-create / session-end and
        // must NOT be touched from the heartbeat path. Previously this also
        // wrote `active: true`, which resurrected sessions that had just been
        // marked dead by a session-end event — because a child process's
        // session-alive heartbeats can land between session-end and the child
        // actually exiting, re-populating pendingUpdate.
        if (sessionUpdates.length > 0) {
            try {
                await Promise.all(sessionUpdates.map(update =>
                    db.session.update({
                        where: { id: update.id },
                        data: { lastActiveAt: new Date(update.timestamp) }
                    })
                ));

                log({ module: 'session-cache' }, `Flushed ${sessionUpdates.length} session updates`);
            } catch (error) {
                log({ module: 'session-cache', level: 'error' }, `Error updating sessions: ${error}`);
            }
        }
        
        // Batch update machines
        if (machineUpdates.length > 0) {
            try {
                await Promise.all(machineUpdates.map(update =>
                    db.machine.update({
                        where: {
                            accountId_id: {
                                accountId: update.userId,
                                id: update.id
                            }
                        },
                        data: { lastActiveAt: new Date(update.timestamp) }
                    })
                ));
                
                log({ module: 'session-cache' }, `Flushed ${machineUpdates.length} machine updates`);
            } catch (error) {
                log({ module: 'session-cache', level: 'error' }, `Error updating machines: ${error}`);
            }
        }
    }

    // Cleanup old cache entries periodically
    cleanup(): void {
        const now = Date.now();
        
        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.validUntil < now) {
                this.sessionCache.delete(sessionId);
            }
        }
        
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.validUntil < now) {
                this.machineCache.delete(machineId);
            }
        }
    }

    shutdown(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }
        
        // Flush any remaining updates
        this.flushPendingUpdates().catch(error => {
            log({ module: 'session-cache', level: 'error' }, `Error flushing final updates: ${error}`);
        });
    }
}

// Global instance
export const activityCache = new ActivityCache();

// Cleanup every 5 minutes
setInterval(() => {
    activityCache.cleanup();
}, 5 * 60 * 1000);