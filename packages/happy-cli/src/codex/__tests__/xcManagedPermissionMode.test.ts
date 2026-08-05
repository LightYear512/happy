import { describe, expect, it } from 'vitest';
import {
    resolveCodexExecutionPolicy,
    resolveCodexSessionPermissionMode,
} from '../executionPolicy';

describe('XC-managed Codex session permission mode', () => {
    it('xc_managed_codex_session_binds_bypass_on_create_and_restore', () => {
        expect(resolveCodexSessionPermissionMode(undefined, 'bypassPermissions', false))
            .toBe('bypassPermissions');
    });

    it('codex_restore_prefers_persisted_explicit_permission_mode', () => {
        expect(resolveCodexSessionPermissionMode('default', 'bypassPermissions', true))
            .toBe('default');
    });

    it('codex_message_without_permission_mode_preserves_session_mode', () => {
        expect(resolveCodexSessionPermissionMode(undefined, 'bypassPermissions', false))
            .toBe('bypassPermissions');
        expect(resolveCodexSessionPermissionMode('read-only', 'bypassPermissions', false))
            .toBe('read-only');
    });

    it('xc_bypass_projects_never_approval_policy', () => {
        expect(resolveCodexExecutionPolicy('bypassPermissions', false)).toEqual({
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
    });
});
