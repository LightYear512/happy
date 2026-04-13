/**
 * Register SIGTERM + SIGINT handlers that run `cleanup()` and then exit.
 *
 * cleanup() runs under a hard 3-second timeout so a hung socket flush or
 * network outage cannot leave the process stuck — the exit is guaranteed.
 *
 * The returned function removes both listeners. Call it from the normal
 * cleanup path so a later second run of the same entry point starts with a
 * clean slate.
 *
 * Windows caveat: Node maps `process.kill(pid, 'SIGTERM')` to `TerminateProcess`
 * and does NOT run handlers. The daemon compensates by walking the process
 * tree with `taskkill /T` (see utils/processKill.ts). These handlers still
 * cover Unix and interactive Ctrl-C.
 */
const CLEANUP_TIMEOUT_MS = 3000;

export function registerShutdownHandlers(cleanup: () => Promise<void>): () => void {
  const handle = async () => {
    await Promise.race([
      cleanup().catch(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, CLEANUP_TIMEOUT_MS)),
    ]);
    process.exit(0);
  };
  const onSigTerm = () => { void handle(); };
  const onSigInt = () => { void handle(); };
  process.on('SIGTERM', onSigTerm);
  process.on('SIGINT', onSigInt);
  return () => {
    process.removeListener('SIGTERM', onSigTerm);
    process.removeListener('SIGINT', onSigInt);
  };
}
