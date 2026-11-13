-- Match the existing per-session ORDER BY createdAt DESC LIMIT query.
-- Run outside a transaction so normal message writes can continue.
CREATE INDEX CONCURRENTLY "SessionMessage_sessionId_createdAt_idx"
ON "public"."SessionMessage" ("sessionId", "createdAt" DESC);
