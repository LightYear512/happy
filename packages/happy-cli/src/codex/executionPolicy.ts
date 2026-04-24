import type { CodexSessionConfig } from './types';

type CodexApprovalPolicy = NonNullable<CodexSessionConfig['approval-policy']>;
type CodexSandboxMode = NonNullable<CodexSessionConfig['sandbox']>;

/**
 * Single source of truth for the Codex protocol value sets accepted by
 * `turn/start` (approvalPolicy) and `sandboxPolicy`. Tests import these
 * arrays so protocol-domain assertions stay coupled to the type definitions
 * instead of duplicated as string literals that drift over time.
 *
 * The `_AssertExhaustive*` constants below use the standard TypeScript
 * type-level equality trick: if the exported array's value-union ever
 * diverges from `CodexApprovalPolicy` / `CodexSandboxMode` (either side
 * gains or loses a member), the assignment fails to type-check.
 */
export const CODEX_APPROVAL_POLICY_VALUES = [
    'untrusted',
    'on-failure',
    'on-request',
    'never',
] as const;

export const CODEX_SANDBOX_MODE_VALUES = [
    'read-only',
    'workspace-write',
    'danger-full-access',
] as const;

type Equals<X, Y> =
    (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

const _AssertExhaustiveApproval: Equals<
    CodexApprovalPolicy,
    (typeof CODEX_APPROVAL_POLICY_VALUES)[number]
> = true;

const _AssertExhaustiveSandbox: Equals<
    CodexSandboxMode,
    (typeof CODEX_SANDBOX_MODE_VALUES)[number]
> = true;

void _AssertExhaustiveApproval;
void _AssertExhaustiveSandbox;

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
