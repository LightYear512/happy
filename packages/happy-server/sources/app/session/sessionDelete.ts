import { Context } from "@/context";
import { inTx, afterTx } from "@/storage/inTx";
import { eventRouter, buildDeleteSessionUpdate } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { log } from "@/utils/log";

/**
 * Delete a session and all its related data.
 * Handles:
 * - Deleting all session messages
 * - Deleting all usage reports for the session
 * - Deleting all access keys for the session
 * - Deleting the session itself
 * - Sending socket notification to all connected clients
 * 
 * @param ctx - Context with user information
 * @param sessionId - ID of the session to delete
 * @returns the deletion result; conditional preconditions are checked in the same transaction
 */
export type SessionDeleteResult = 'deleted' | 'not-found' | 'precondition-failed';
export interface SessionDeleteCondition { expectedAccountId: string; before: Date }

export async function sessionDelete(ctx: Context, sessionId: string,
    condition?: SessionDeleteCondition): Promise<SessionDeleteResult> {
    return await inTx(async (tx) => {
        if (condition && condition.expectedAccountId !== ctx.uid) {
            return 'precondition-failed';
        }
        // Verify session exists and belongs to the user
        const session = await tx.session.findFirst({
            where: {
                id: sessionId,
                accountId: ctx.uid
            }
        });

        if (!session) {
            log({ 
                module: 'session-delete', 
                userId: ctx.uid, 
                sessionId 
            }, `Session not found or not owned by user`);
            return 'not-found';
        }
        if (condition && (session.active || session.lastActiveAt >= condition.before)) {
            return 'precondition-failed';
        }

        // Delete all related data
        // Note: Order matters to avoid foreign key constraint violations
        
        // 1. Delete session messages
        const deletedMessages = await tx.sessionMessage.deleteMany({
            where: { sessionId }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionId,
            deletedCount: deletedMessages.count
        }, `Deleted ${deletedMessages.count} session messages`);

        // 2. Delete usage reports
        const deletedReports = await tx.usageReport.deleteMany({
            where: { sessionId }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionId,
            deletedCount: deletedReports.count
        }, `Deleted ${deletedReports.count} usage reports`);

        // 3. Delete access keys
        const deletedAccessKeys = await tx.accessKey.deleteMany({
            where: { sessionId }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionId,
            deletedCount: deletedAccessKeys.count
        }, `Deleted ${deletedAccessKeys.count} access keys`);

        // 4. Delete the session itself
        await tx.session.delete({
            where: { id: sessionId }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionId 
        }, `Session deleted successfully`);

        // Send notification after transaction commits
        afterTx(tx, async () => {
            const updSeq = await allocateUserSeq(ctx.uid);
            const updatePayload = buildDeleteSessionUpdate(sessionId, updSeq, randomKeyNaked(12));
            
            log({
                module: 'session-delete',
                userId: ctx.uid,
                sessionId,
                updateType: 'delete-session',
                updatePayload: JSON.stringify(updatePayload)
            }, `Emitting delete-session update to user-scoped connections`);

            eventRouter.emitUpdate({
                userId: ctx.uid,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });
        });

        return 'deleted';
    });
}
