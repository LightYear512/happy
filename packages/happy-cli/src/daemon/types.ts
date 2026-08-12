/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

export const XC_VIRTUAL_SESSION_ID_PATTERN = /^x-[0-9]{6}(?:-[1-9][0-9]{0,2})?$/u;

export type SessionInputState = 'online' | 'offline' | 'unknown';

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** tmux session identifier (format: session:window) */
  tmuxSessionId?: string;
  /** Claude session ID this process is resuming (set at spawn time for dedup) */
  resumeTarget?: string;
  /** Exact Happy session ID required when restoring a closed session. */
  expectedHappySessionId?: string;
  /** Provider identity proved ready by the current child; omitted webhooks never clear it. */
  observedProviderSessionId?: string;
  /** Whether this is the daemon console session (should not be restorable) */
  isConsoleSession?: boolean;
}

export interface ObservedTrackedSession extends TrackedSession {
  inputState: SessionInputState;
}
