# Happy Codex Provider Readiness

## Public Boundary Matrix

The daemon may acknowledge a freshly spawned Codex child only after the Happy
session has one durable, canonical Codex thread identifier. Creating that thread
must not start a model turn or synthesize a user message. Claude and terminal
sessions keep their existing registration behavior.

## Budget Ledger

One daemon spawn owns at most one pre-turn `thread/start`; zero `turn/start`
requests are permitted before real input. The implementation reuses the existing
Codex app-server client, metadata writer and daemon webhook.

## Lifecycle State Matrix

`Happy session created` advances to `provider ready` only after `thread/start`
returns a canonical identifier and the metadata update is acknowledged. Only
then may the daemon resolve its spawn awaiter. A premature Codex webhook is
ignored and cannot create a successful spawn receipt.

## Digest And Provenance Matrix

The provider identifier comes only from the real app-server `thread/start`
response, is stored in `metadata.claudeSessionId`, and is independently checked
by the daemon before it accepts the child webhook. Restore continues to consume
that same server-backed metadata field.

## Non-goals

No hidden model turn, synthetic provider identifier, fallback restore authority,
second session record, XC-specific parser, or change to user-facing titles is
introduced.
