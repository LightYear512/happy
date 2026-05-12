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

    // ─── Race-recovery buffer for /compact ────────────────────────────────
    //
    // Contract: every prompt accepted by onUserMessage must be mirrored into
    // an in-memory ring (`recentUserBuffer.record`) BEFORE pushing into the
    // message queue, and that ring must be snapshotted into buildHeuristicSeed
    // as `extraUserTexts` so the seed can recover prompts that haven't yet
    // flushed to rollout. The ring must also be cleared inside the compact
    // critical section (between compactInFlight=true and compactInFlight=false)
    // and AFTER the seed has been committed to compactState.pendingSeedText.
    //
    // The buffer FIFO behaviour itself is covered in `recentUserBuffer.test.ts`
    // — these contracts only enforce wiring at the call site, not algorithm.
    describe('race-recovery buffer wiring contracts', () => {
        // Find every `<obj>.<method>(...)` call expression in a subtree.
        const findMethodCalls = (root: ts.Node, obj: string, method: string) =>
            findAllNodes(root, (n): n is ts.CallExpression =>
                ts.isCallExpression(n)
                && ts.isPropertyAccessExpression(n.expression)
                && ts.isIdentifier(n.expression.expression)
                && n.expression.expression.text === obj
                && n.expression.name.text === method,
            );

        // Find an assignment `target = <literal>` whose RHS is a specific
        // SyntaxKind (e.g. TrueKeyword / FalseKeyword).
        const findLiteralAssignment = (root: ts.Node, target: string, valueKind: ts.SyntaxKind) =>
            findFirstNode(root, (n): n is ts.BinaryExpression =>
                ts.isBinaryExpression(n)
                && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
                && ts.isIdentifier(n.left)
                && n.left.text === target
                && n.right.kind === valueKind,
            );

        // Find an assignment `<obj>.<prop> = anything` in a subtree.
        const findPropertyAssignment = (root: ts.Node, obj: string, prop: string) =>
            findFirstNode(root, (n): n is ts.BinaryExpression =>
                ts.isBinaryExpression(n)
                && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
                && ts.isPropertyAccessExpression(n.left)
                && ts.isIdentifier(n.left.expression)
                && n.left.expression.text === obj
                && n.left.name.text === prop,
            );

        const findRunManualCompact = (): ts.FunctionDeclaration | null =>
            findFirstNode(SF, (n): n is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(n) && !!n.name && n.name.text === 'runManualCompact',
            );

        const findVarDeclPos = (name: string): number => {
            const decl = findFirstNode(SF, (n): n is ts.VariableDeclaration =>
                ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name,
            );
            return decl ? decl.getStart(SF) : -1;
        };

        it('declares `recentUserBuffer` before EVERY `session.onUserMessage(...)` registration', () => {
            const declPos = findVarDeclPos('recentUserBuffer');
            // We require the declaration to live before ALL registrations, so a
            // future second `session.onUserMessage` won't accidentally race.
            const regPositions = findMethodCalls(SF, 'session', 'onUserMessage').map((c) => c.getStart(SF));
            expect(declPos, '`recentUserBuffer` must be declared').toBeGreaterThan(-1);
            expect(regPositions.length, 'at least one onUserMessage registration must exist').toBeGreaterThan(0);
            for (const regPos of regPositions) {
                expect(
                    declPos,
                    `declaration at offset ${declPos} must precede onUserMessage at offset ${regPos}`,
                ).toBeLessThan(regPos);
            }
        });

        it('records every user prompt via `recentUserBuffer.record(...)` BEFORE pushing into the message queue', () => {
            const pushCalls = findMethodCalls(SF, 'messageQueue', 'push');
            expect(pushCalls.length, '`messageQueue.push(...)` must exist somewhere').toBeGreaterThan(0);

            // We only enforce the contract on push calls inside an
            // `onUserMessage` callback — `executeBangCommand` etc. may legitimately
            // push synthesised content without going through the user buffer.
            // Heuristic: the enclosing scope's parent must be `session.onUserMessage(...)`.
            for (const pushCall of pushCalls) {
                let scope: ts.Node | undefined = pushCall.parent;
                while (
                    scope &&
                    !ts.isFunctionDeclaration(scope) &&
                    !ts.isArrowFunction(scope) &&
                    !ts.isFunctionExpression(scope)
                ) {
                    scope = scope.parent;
                }
                if (!scope) continue;

                const parentCall = scope.parent;
                if (!parentCall || !ts.isCallExpression(parentCall)) continue;
                const callee = parentCall.expression;
                if (!ts.isPropertyAccessExpression(callee)) continue;
                if (!ts.isIdentifier(callee.expression)) continue;
                if (callee.expression.text !== 'session') continue;
                if (callee.name.text !== 'onUserMessage') continue;

                const recordCalls = findMethodCalls(scope, 'recentUserBuffer', 'record');
                expect(
                    recordCalls.length,
                    'expected at least one `recentUserBuffer.record(...)` in the onUserMessage callback',
                ).toBeGreaterThan(0);

                const minRecordPos = Math.min(...recordCalls.map((c) => c.getStart(SF)));
                expect(
                    minRecordPos,
                    'record must commit before push (push throwing synchronously could skip it otherwise)',
                ).toBeLessThan(pushCall.getStart(SF));
            }
        });

        it('passes `recentUserBuffer.snapshot()` as `extraUserTexts` to buildHeuristicSeed inside runManualCompact', () => {
            // Scan limited to runManualCompact — codexExecCompact's L2 pipeline
            // runs in a fresh codex process with no buffer to consume.
            const compactFn = findRunManualCompact();
            expect(compactFn, 'runManualCompact must exist (anchor)').not.toBeNull();
            if (!compactFn) return;

            const seedCalls = findAllNodes(compactFn, (n): n is ts.CallExpression =>
                ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'buildHeuristicSeed',
            );
            expect(seedCalls.length, 'buildHeuristicSeed must be called inside runManualCompact').toBeGreaterThan(0);

            for (const call of seedCalls) {
                const arg = call.arguments[0];
                expect(arg, 'buildHeuristicSeed must receive an options object').toBeDefined();
                expect(ts.isObjectLiteralExpression(arg!)).toBe(true);
                const extra = (arg as ts.ObjectLiteralExpression).properties.find(
                    (p): p is ts.PropertyAssignment =>
                        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'extraUserTexts',
                );
                expect(extra, 'must pass `extraUserTexts`').toBeDefined();
                if (!extra) continue;

                // Value must be `recentUserBuffer.snapshot()` — the helper
                // contractually returns a copy, so the seed builder sees a
                // frozen view regardless of subsequent buffer mutations.
                const value = extra.initializer;
                expect(
                    ts.isCallExpression(value),
                    '`extraUserTexts` must be a call expression (recentUserBuffer.snapshot())',
                ).toBe(true);
                if (!ts.isCallExpression(value)) continue;
                expect(value.expression.getText(SF)).toBe('recentUserBuffer.snapshot');
                expect(value.arguments.length).toBe(0);
            }
        });

        it('clears the buffer inside the compact critical section after committing the seed', () => {
            // Four anchor points must obey A < B < C < D:
            //   A: compactInFlight = true       (entry to critical section)
            //   B: compactState.pendingSeedText = seedText  (seed committed)
            //   C: recentUserBuffer.clear()     (the reset itself)
            //   D: compactInFlight = false      (exit of critical section)
            const compactFn = findRunManualCompact();
            expect(compactFn, 'runManualCompact must exist (anchor)').not.toBeNull();
            if (!compactFn) return;

            const a = findLiteralAssignment(compactFn, 'compactInFlight', ts.SyntaxKind.TrueKeyword);
            const d = findLiteralAssignment(compactFn, 'compactInFlight', ts.SyntaxKind.FalseKeyword);
            const b = findPropertyAssignment(compactFn, 'compactState', 'pendingSeedText');
            const clearCalls = findMethodCalls(compactFn, 'recentUserBuffer', 'clear');

            expect(a, 'A: `compactInFlight = true` must exist').not.toBeNull();
            expect(d, 'D: `compactInFlight = false` must exist').not.toBeNull();
            expect(b, 'B: `compactState.pendingSeedText = seedText` must exist').not.toBeNull();
            expect(
                clearCalls.length,
                'C: `recentUserBuffer.clear()` must be called in runManualCompact',
            ).toBeGreaterThan(0);
            if (!a || !b || !d) return;

            const posA = a.getStart(SF);
            const posB = b.getStart(SF);
            const posD = d.getStart(SF);
            // At least one clear must obey A < B < C < D (allow multiple call
            // sites in case future success+failure branches both reset).
            const validClears = clearCalls.filter((c) => {
                const posC = c.getStart(SF);
                return posA < posB && posB < posC && posC < posD;
            });
            expect(
                validClears.length,
                'expected `recentUserBuffer.clear()` to be placed AFTER ' +
                '`compactState.pendingSeedText = seedText` and BEFORE ' +
                '`compactInFlight = false` (i.e. on the try-block success path)',
            ).toBeGreaterThan(0);
        });
    });
});
