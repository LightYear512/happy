import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = resolve(__dirname, '..', 'runCodexAppServer.ts');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');
const SF = ts.createSourceFile(SOURCE_PATH, SOURCE, ts.ScriptTarget.Latest, true);

/**
 * Source-level AST regression contract for runCodexAppServer.
 *
 * Background: switching the in-app permission mode (e.g. default -> yolo) used
 * to flip the MessageQueue2 mode hash, which the turn loop interpreted as
 * "rebuild the Codex thread". That destroyed the Codex-side conversation
 * (new threadId, new rollout .jsonl, prior context lost).
 *
 * The fix:
 *   - Codex `turn/start` accepts per-turn `approvalPolicy` / `sandboxPolicy`,
 *     so a mode change applies to the next turn without restarting the thread.
 *   - The mode hash remains a MessageQueue2 batching boundary only, never a
 *     thread lifecycle signal.
 *   - `modeHasher` must keep `permissionMode` so prompts at different safety
 *     levels are never merged into the same turn.
 *
 * These contracts are enforced at the AST level (not regex) so simple
 * reformatting/renaming cannot bypass them: we walk the syntax tree and
 * inspect actual assignment expressions and call expression arguments.
 */

// --- AST helpers --------------------------------------------------------

function findFirstNode<T extends ts.Node>(
    root: ts.Node,
    predicate: (node: ts.Node) => node is T,
): T | null {
    let found: T | null = null;
    const visit = (node: ts.Node): void => {
        if (found) return;
        if (predicate(node)) {
            found = node;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
}

function findAllNodes<T extends ts.Node>(
    root: ts.Node,
    predicate: (node: ts.Node) => node is T,
): T[] {
    const acc: T[] = [];
    const visit = (node: ts.Node): void => {
        if (predicate(node)) acc.push(node);
        ts.forEachChild(node, visit);
    };
    visit(root);
    return acc;
}

function isAssignmentTo(node: ts.Node, identifierName: string): boolean {
    if (!ts.isBinaryExpression(node)) return false;
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
    const left = node.left;
    if (ts.isIdentifier(left)) return left.text === identifierName;
    if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.name)) {
        return left.name.text === identifierName;
    }
    return false;
}

/**
 * Find the IfStatement whose condition references `currentModeHash` and
 * `message.hash` together — i.e. the "mode hash changed" branch in the turn
 * loop. Returning null fails the test loudly so a future rewrite cannot
 * silently move the contract out from under us.
 */
function findModeHashChangeBranch(): ts.IfStatement | null {
    return findFirstNode(SF, (node): node is ts.IfStatement => {
        if (!ts.isIfStatement(node)) return false;
        const text = node.expression.getText(SF);
        return /currentModeHash/.test(text) && /message\.hash/.test(text);
    });
}

// --- Contracts ----------------------------------------------------------

describe('runCodexAppServer — AST regression contracts', () => {
    describe('mode-hash-change branch never rebuilds the Codex thread', () => {
        const branch = findModeHashChangeBranch();

        it('the mode-hash-change IfStatement still exists (anchor for other contracts)', () => {
            // If this fails, the entire turn loop has been restructured and
            // every other contract in this file needs to be re-validated by a
            // human. Failing loudly is the point.
            expect(branch).not.toBeNull();
        });

        const FORBIDDEN_ASSIGN_TARGETS = [
            'threadId',
            'threadIdStored',
            'currentModeHash',
            'needsSystemPromptInjection',
            'pending',
        ] as const;

        for (const target of FORBIDDEN_ASSIGN_TARGETS) {
            it(`does not assign to "${target}" inside the mode-hash-change branch`, () => {
                expect(branch, 'mode-hash-change branch must exist (anchor)').not.toBeNull();
                if (!branch) return;
                const assignments = findAllNodes(
                    branch.thenStatement,
                    (n): n is ts.BinaryExpression => isAssignmentTo(n, target),
                );
                if (assignments.length > 0) {
                    const lines = assignments
                        .map((a) => `  L${SF.getLineAndCharacterOfPosition(a.getStart(SF)).line + 1}: ${a.getText(SF)}`)
                        .join('\n');
                    throw new Error(
                        `Found forbidden assignment(s) to "${target}" inside the mode-hash-change branch.\n` +
                        `This is the regression that lost the Codex conversation when the user toggled the permission mode.\n` +
                        `Offending assignments:\n${lines}`,
                    );
                }
                expect(assignments).toHaveLength(0);
            });
        }

        it('does not call permissionHandler.reset / reasoningProcessor.abort / diffProcessor.reset inside the branch', () => {
            // These were part of the old rebuild teardown. The shared `finally`
            // block at the end of every turn already performs them; calling
            // them inline here would re-introduce the eager teardown that the
            // old rebuild path needed.
            expect(branch, 'mode-hash-change branch must exist (anchor)').not.toBeNull();
            if (!branch) return;
            const calls = findAllNodes(
                branch.thenStatement,
                (n): n is ts.CallExpression => ts.isCallExpression(n),
            );
            const offenders = calls
                .map((c) => c.expression.getText(SF))
                .filter((expr) =>
                    expr === 'permissionHandler.reset' ||
                    expr === 'reasoningProcessor.abort' ||
                    expr === 'diffProcessor.reset',
                );
            expect(offenders).toEqual([]);
        });

        it('does not contain a `continue` statement inside the branch', () => {
            // The old rebuild path ended with `continue` to restart the loop
            // with `threadId === null`. Its presence today would mean the
            // current message is being re-queued instead of consumed normally.
            expect(branch, 'mode-hash-change branch must exist (anchor)').not.toBeNull();
            if (!branch) return;
            const continues = findAllNodes(
                branch.thenStatement,
                (n): n is ts.ContinueStatement => ts.isContinueStatement(n),
            );
            expect(continues).toEqual([]);
        });
    });

    describe('turn/start passes per-turn approvalPolicy and sandboxPolicy', () => {
        // Find every `client.request('turn/start', { ... })` call. The fix
        // depends on Codex applying these per-turn so the thread can stay
        // alive across mode changes.
        const turnStartCalls = findAllNodes(SF, (n): n is ts.CallExpression => {
            if (!ts.isCallExpression(n)) return false;
            if (!ts.isPropertyAccessExpression(n.expression)) return false;
            if (n.expression.name.text !== 'request') return false;
            const firstArg = n.arguments[0];
            return (
                !!firstArg &&
                ts.isStringLiteral(firstArg) &&
                firstArg.text === 'turn/start'
            );
        });

        it('at least one turn/start call exists', () => {
            expect(turnStartCalls.length).toBeGreaterThan(0);
        });

        for (let i = 0; i < turnStartCalls.length; i++) {
            const call = turnStartCalls[i];
            const line = SF.getLineAndCharacterOfPosition(call.getStart(SF)).line + 1;

            it(`turn/start call at L${line} passes approvalPolicy`, () => {
                const params = call.arguments[1];
                expect(params, 'turn/start must receive a params object').toBeDefined();
                expect(ts.isObjectLiteralExpression(params!)).toBe(true);
                const keys = (params as ts.ObjectLiteralExpression).properties.flatMap(
                    (p) => (p.name && ts.isIdentifier(p.name) ? [p.name.text] : []),
                );
                expect(keys).toContain('approvalPolicy');
            });

            it(`turn/start call at L${line} passes sandboxPolicy`, () => {
                const params = call.arguments[1] as ts.ObjectLiteralExpression;
                const keys = params.properties.flatMap(
                    (p) => (p.name && ts.isIdentifier(p.name) ? [p.name.text] : []),
                );
                expect(keys).toContain('sandboxPolicy');
            });
        }
    });

    describe('MessageQueue2 modeHasher keeps permissionMode in the hash', () => {
        // Find `new MessageQueue2(...)` and walk into its first argument
        // (the modeHasher arrow function) to confirm it still references
        // `permissionMode` on the input. Dropping this would let prompts at
        // different safety levels be merged into the same turn.
        const newExpr = findFirstNode(SF, (n): n is ts.NewExpression => {
            if (!ts.isNewExpression(n)) return false;
            return ts.isIdentifier(n.expression) && n.expression.text === 'MessageQueue2';
        });

        it('a MessageQueue2 constructor call exists', () => {
            expect(newExpr).not.toBeNull();
        });

        it('the modeHasher argument references `permissionMode` on its input', () => {
            expect(newExpr, 'MessageQueue2 constructor must exist (anchor)').not.toBeNull();
            if (!newExpr) return;
            const hasherArg = newExpr.arguments?.[0];
            expect(hasherArg, 'MessageQueue2 must be constructed with a modeHasher').toBeDefined();
            const propAccesses = findAllNodes(
                hasherArg!,
                (n): n is ts.PropertyAccessExpression =>
                    ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name) && n.name.text === 'permissionMode',
            );
            expect(propAccesses.length).toBeGreaterThan(0);
        });
    });

    describe('mode-hash-change branch still surfaces a UI status message', () => {
        // After deleting the rebuild path we kept a `messageBuffer.addMessage`
        // so the user sees that the permission-mode switch was received.
        // Without it, toggling the mode in the app produces no feedback.
        const branch = findModeHashChangeBranch();

        it('calls messageBuffer.addMessage with status type', () => {
            expect(branch, 'mode-hash-change branch must exist (anchor)').not.toBeNull();
            if (!branch) return;
            const calls = findAllNodes(
                branch.thenStatement,
                (n): n is ts.CallExpression => ts.isCallExpression(n),
            );
            const isAddMessageStatus = (call: ts.CallExpression): boolean => {
                if (!ts.isPropertyAccessExpression(call.expression)) return false;
                if (call.expression.name.text !== 'addMessage') return false;
                const second = call.arguments[1];
                return !!second && ts.isStringLiteral(second) && second.text === 'status';
            };
            expect(calls.some(isAddMessageStatus)).toBe(true);
        });
    });
});
