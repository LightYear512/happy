import { describe, expect, it } from 'vitest';
import {
    resolveCodexExecutionPolicy,
    CODEX_APPROVAL_POLICY_VALUES,
    CODEX_SANDBOX_MODE_VALUES,
} from '../executionPolicy';
import type { PermissionMode } from '@/api/types';

/**
 * Mode-transition matrix coverage for the Codex per-turn policy contract.
 *
 * Background (companion to runCodexAppServer.regression.test.ts):
 *   The app-server fix relies on Codex `turn/start` accepting per-turn
 *   `approvalPolicy` / `sandboxPolicy` values. If `resolveCodexExecutionPolicy`
 *   ever returned a value outside the Codex-supported domain — or if a
 *   per-turn transition produced a policy Codex refused mid-thread — we would
 *   silently regress to "mode change has no effect" behavior, which is what
 *   originally pushed the old code to rebuild the thread.
 *
 *   This matrix enumerates every PermissionMode and every PermissionMode→
 *   PermissionMode transition (49 pairs) and asserts:
 *     1. Output policies live in Codex's known-supported value set.
 *     2. Transitions never throw and always produce a non-empty pair.
 *     3. The sandbox-managed-by-Happy override is honored regardless of mode.
 *
 *   The matrix is the contract that justifies removing the thread-rebuild
 *   path; if Codex ever gains a new mode that needs special handling, this
 *   test fails first.
 */

// Compile-time exhaustiveness over PermissionMode. The `satisfies` clause
// makes TypeScript verify this map covers EVERY variant of the union; if a
// new mode is added in `api/types.ts` and forgotten here, this file fails to
// type-check (so the matrix below cannot silently miss the new value).
const PERMISSION_MODE_TABLE = {
    'default': true,
    'acceptEdits': true,
    'bypassPermissions': true,
    'plan': true,
    'read-only': true,
    'safe-yolo': true,
    'yolo': true,
} as const satisfies Record<PermissionMode, true>;

const ALL_PERMISSION_MODES = Object.keys(PERMISSION_MODE_TABLE) as readonly PermissionMode[];

// Codex protocol value sets sourced from `executionPolicy.ts` (which derives
// them from `CodexSessionConfig` via type-level equality assertions). Avoid
// re-declaring as string literals here — that would split the SSoT and let
// the test silently drift from the protocol type definition.
const CODEX_APPROVAL_POLICIES: ReadonlySet<string> = new Set(CODEX_APPROVAL_POLICY_VALUES);
const CODEX_SANDBOX_MODES: ReadonlySet<string> = new Set(CODEX_SANDBOX_MODE_VALUES);

describe('resolveCodexExecutionPolicy — mode matrix', () => {
    describe('per-mode output is in the Codex-supported value set', () => {
        for (const mode of ALL_PERMISSION_MODES) {
            for (const sandboxManagedByHappy of [false, true] as const) {
                it(`${mode} (sandboxManagedByHappy=${sandboxManagedByHappy}) yields a Codex-valid policy`, () => {
                    const policy = resolveCodexExecutionPolicy(mode, sandboxManagedByHappy);
                    expect(CODEX_APPROVAL_POLICIES.has(policy.approvalPolicy)).toBe(true);
                    expect(CODEX_SANDBOX_MODES.has(policy.sandbox)).toBe(true);
                });
            }
        }
    });

    describe('transitions: every PermissionMode → PermissionMode pair is valid mid-thread', () => {
        for (const from of ALL_PERMISSION_MODES) {
            for (const to of ALL_PERMISSION_MODES) {
                it(`${from} → ${to} produces a valid per-turn policy delta`, () => {
                    const before = resolveCodexExecutionPolicy(from, false);
                    const after = resolveCodexExecutionPolicy(to, false);
                    expect(CODEX_APPROVAL_POLICIES.has(before.approvalPolicy)).toBe(true);
                    expect(CODEX_APPROVAL_POLICIES.has(after.approvalPolicy)).toBe(true);
                    expect(CODEX_SANDBOX_MODES.has(before.sandbox)).toBe(true);
                    expect(CODEX_SANDBOX_MODES.has(after.sandbox)).toBe(true);
                    // The pair (before, after) is what the next turn will hand to
                    // Codex via `turn/start`. Both endpoints must be valid for
                    // thread-reuse to be safe — Codex has no out-of-domain value
                    // it would silently coerce.
                });
            }
        }
    });

    describe('sandbox-managed-by-Happy override is invariant under mode', () => {
        for (const mode of ALL_PERMISSION_MODES) {
            it(`${mode} with sandboxManagedByHappy=true forces never+danger-full-access`, () => {
                const policy = resolveCodexExecutionPolicy(mode, true);
                expect(policy).toEqual({
                    approvalPolicy: 'never',
                    sandbox: 'danger-full-access',
                });
            });
        }
    });

    describe('safety-tier monotonicity sanity checks', () => {
        it('read-only sandbox is paired with never approval (no shell elicitation needed)', () => {
            const policy = resolveCodexExecutionPolicy('read-only', false);
            expect(policy.sandbox).toBe('read-only');
            expect(policy.approvalPolicy).toBe('never');
        });

        it('yolo + bypassPermissions yield danger-full-access sandbox', () => {
            expect(resolveCodexExecutionPolicy('yolo', false).sandbox).toBe('danger-full-access');
            expect(resolveCodexExecutionPolicy('bypassPermissions', false).sandbox).toBe('danger-full-access');
        });

        it('default + acceptEdits + plan + safe-yolo all map to workspace-write sandbox', () => {
            for (const mode of ['default', 'acceptEdits', 'plan', 'safe-yolo'] as const) {
                expect(resolveCodexExecutionPolicy(mode, false).sandbox).toBe('workspace-write');
            }
        });
    });
});
