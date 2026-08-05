# AT-0057 Happy Server session restore race

## Module lock

- module: `happy-server.sessionUpdateHandler`
- matrix: `packages/happy-server/sessionUpdateHandler.contract-matrix.AT-0057.json`
- design_entry: `.claude/designs/AT-0057-happy-server-session-restore-race.md`
- allowed_paths:
  - `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts`
  - `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.spec.ts`
  - `packages/happy-server/sessionUpdateHandler.contract-matrix.AT-0057.json`

## Problem

`killSession` acknowledges before deferred cleanup. A user message can therefore be
persisted while the session still projects `active=true` and a fresh heartbeat. The
message-time `tryRestoreSession` call returns false. If `session-end` arrives next,
the server marks the session inactive but never re-evaluates that persisted input,
leaving no provider process to consume it.

## Contract

The server records only an opaque wake trigger: session id, authoritative message
sequence, user id, and observation time. It never decrypts message bodies. A later
session-scoped persisted message with a greater sequence acknowledges that trigger.
If `session-end` arrives first, the handler consumes the trigger exactly once and
calls the existing `tryRestoreSession` path after marking the session dead.

The trigger registry is bounded by a TTL and maximum entry count. Expired entries
cannot revive old sessions. Eviction is deterministic oldest-first. Restore still
requires the existing daemon routing, restoring lock, acknowledgement, DB update,
cache invalidation, and ephemeral activity projection.

## Event ordering

1. User message then agent/session message: clear trigger; later close stays closed.
2. User message then session-end: mark dead, consume trigger, restore once.
3. Session-end then user message: existing inactive-session restore path handles it.
4. Duplicate user messages: retain the greatest authoritative message sequence.
5. Expired trigger then session-end: do not restore.

## Validation

- Red tests reproduce user-message/session-end and acknowledged-message/session-end orderings.
- Focused Vitest suite passes after implementation.
- TypeScript build passes.
- Contract-first gate passes against the matrix.

## Non-goals

- No XC auto-restart behavior.
- No database migration or encrypted message inspection.
- No replay, fallback process, synthetic input, or manual session state edit.
