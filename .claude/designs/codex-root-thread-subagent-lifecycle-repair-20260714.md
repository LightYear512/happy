# Codex root-thread lifecycle repair

Date: 2026-07-14

## Problem

`runCodexAppServer` currently treats every `turn/started` notification as the
top-level turn. Codex multi-agent v2 emits the same notification for child
agents, so a child `threadId` replaces the Happy session's root `threadId` and
a child turn replaces `activeTurnId`. The next prompt is then sent directly to
the child and Codex rejects it. Abort and close target the wrong turn as well.

## Repair

- Keep the root `threadId` sourced only from `thread/start` or `thread/resume`.
- Ignore child-thread started/completed/interrupted/error notifications for the
  root lifecycle state machine.
- Continue forwarding item/subagent activity so the UI still shows workers.
- Bind `activeTurnId` to the root `turn/start` RPC response as a fallback for
  notification ordering.
- Preserve account switching by resuming the immutable root thread.

## Verification

An app-server E2E test emits a child turn inside a root turn, completes both,
and submits a second user prompt. Both `turn/start` requests must target the
same root thread. The fake server rejects child-thread direct input with the
real Codex error so the regression cannot pass through a cosmetic UI change.

Only the two affected Happy sessions need restarting after deployment.
