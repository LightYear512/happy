# Happy Codex Account Authority

## Public Boundary Matrix

`buildDaemonChildEnvironment` is the only daemon boundary that projects a
Codex account into a new child process. An explicit `CODEX_HOME` supplied by a
token or GUI profile is preserved. Otherwise both fresh and restored children
must start without the daemon's inherited `CODEX_HOME`, so the existing Codex
startup path resolves the current durable default profile.

## Budget Ledger

The repair adds no profile reader, no persisted field and no startup I/O. It
changes one existing condition with zero net production LOC.

## Lifecycle State Matrix

A committed account selection updates the durable Codex default. A later child
spawn consumes that default through the normal Codex startup path. Resume
identity selects the existing conversation only; it never selects an account.

## Digest And Provenance Matrix

The account source is either the explicit spawn environment or the current
Codex default configuration. The daemon process environment is launch history,
not account provenance. `CODEX_THREAD_ID` remains excluded and the exact resume
identifier remains an argument rather than an environment-derived authority.

## Non-goals

No account migration, fallback profile, second profile parser, session-specific
account persistence, title change or XC-side compensation is introduced.
