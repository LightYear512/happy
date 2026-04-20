import type { CodexSessionConfig } from './types';

type CodexApprovalPolicy = NonNullable<CodexSessionConfig['approval-policy']>;
type CodexSandboxMode = NonNullable<CodexSessionConfig['sandbox']>;

export function resolveCodexExecutionPolicy(
    permissionMode: import('@/api/types').PermissionMode,
    sandboxManagedByHappy: boolean,
): { approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandboxMode } {
    if (sandboxManagedByHappy) {
        return {
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        };
    }

    // Use 'on-request' for most modes — it lets the model auto-execute MCP tool calls while
    // still routing shell command approvals via standard MCP ElicitRequest (handled by CodexPermissionHandler).
    // Avoid 'untrusted' which triggers non-standard codex/event elicitation for MCP tool calls
    // that cannot be responded to in headless/remote mode.
    const approvalPolicy: CodexApprovalPolicy = (() => {
        switch (permissionMode) {
            case 'default': return 'on-request';
            case 'read-only': return 'never';
            case 'safe-yolo': return 'on-failure';
            case 'yolo': return 'on-failure';
            case 'bypassPermissions': return 'on-failure';
            case 'acceptEdits': return 'on-request';
            case 'plan': return 'on-request';
            default: return 'on-request';
        }
    })();

    const sandbox: CodexSandboxMode = (() => {
        switch (permissionMode) {
            case 'default': return 'workspace-write';
            case 'read-only': return 'read-only';
            case 'safe-yolo': return 'workspace-write';
            case 'yolo': return 'danger-full-access';
            case 'bypassPermissions': return 'danger-full-access';
            case 'acceptEdits': return 'workspace-write';
            case 'plan': return 'workspace-write';
            default: return 'workspace-write';
        }
    })();

    return { approvalPolicy, sandbox };
}
