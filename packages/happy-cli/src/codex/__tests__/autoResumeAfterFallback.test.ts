import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import * as ts from 'typescript';
import { buildHeuristicSeed } from '../utils/compactSeedBuilder';
import { findAllNodes, findFirstNode, findMethodCalls } from './astHelpers';

/**
 * Regression contracts for the auto-resume-after-fallback-compact fix
 * (commit 604a4238, runCodexAppServer.ts L656-665).
 *
 * Background: after codex's server-side compact fails and our heuristic
 * fallback finishes, the user previously had to manually type something to
 * continue. Production log analysis (685 events) showed ~80% of users typed
 * a no-op catch-up ("继续" 54.6%). The fix pushes a synthetic "继续" into
 * the queue once the seed is stashed.
 *
 * These contracts catch four classes of regression:
 *   1. The block is removed entirely (revert).
 *   2. The push escapes the `autoTriggered` guard (manual /compact suddenly
 *      starts auto-replaying — would be a UX bug).
 *   3. The replay text drifts (e.g. someone changes it to "请继续" — log
 *      analysis says "继续" is what users actually type byte-for-byte).
 *   4. The `recentUserBuffer.record` ordering breaks (push throws sync →
 *      buffer never sees the replay → next seed loses the turn).
 *
 * Plus one runtime sanity check against the largest real ~/.codex rollout
 * to confirm the fallback path (heuristic seed) still produces a valid
 * seed for a large-context conversation — the path that triggers the
 * auto-resume in production.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = resolve(__dirname, '..', 'runCodexAppServer.ts');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');
const SF = ts.createSourceFile(SOURCE_PATH, SOURCE, ts.ScriptTarget.Latest, true);

// ── Local helpers (generic AST traversal lives in ./astHelpers) ──────────

const findRunManualCompact = (): ts.FunctionDeclaration | null =>
    findFirstNode(SF, (n): n is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(n) && !!n.name && n.name.text === 'runManualCompact',
    );

/**
 * Find the `if (mode === 'compact' && autoTriggered) { ... }` block — the
 * sole anchor for the auto-resume contract. We pattern-match the actual AST
 * shape (binary && with both operands present), not the source text, so
 * reformatting cannot break the test.
 */
function findAutoResumeIfBlock(): ts.IfStatement | null {
    const compactFn = findRunManualCompact();
    if (!compactFn) return null;
    return findFirstNode(compactFn, (n): n is ts.IfStatement => {
        if (!ts.isIfStatement(n)) return false;
        if (!ts.isBinaryExpression(n.expression)) return false;
        if (n.expression.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return false;
        const text = n.expression.getText(SF);
        return /mode\s*===\s*['"]compact['"]/.test(text) && /autoTriggered/.test(text);
    });
}

describe('runCodexAppServer — auto-resume after fallback compact', () => {
    describe('auto-resume if-block contracts', () => {
        const block = findAutoResumeIfBlock();

        it('exists inside runManualCompact (anchor — revert detection)', () => {
            // If this fails the fix has been reverted. The commit message of
            // 604a4238 describes why the block must stay; restore it before
            // editing other contracts.
            expect(block).not.toBeNull();
        });

        it('calls `messageQueue.push(...)` exactly once inside the block', () => {
            expect(block, 'auto-resume block must exist (anchor)').not.toBeNull();
            if (!block) return;
            const pushes = findMethodCalls(block.thenStatement, 'messageQueue', 'push');
            // Exactly one — multiple pushes here would duplicate the replay
            // turn and confuse the model (the comment in the source explicitly
            // calls out that M1 is NOT re-pushed for this reason).
            expect(pushes).toHaveLength(1);
        });

        it('the messageQueue.push first argument is a value that resolves to "继续"', () => {
            expect(block, 'auto-resume block must exist (anchor)').not.toBeNull();
            if (!block) return;
            const pushes = findMethodCalls(block.thenStatement, 'messageQueue', 'push');
            expect(pushes.length).toBeGreaterThan(0);
            const firstArg = pushes[0].arguments[0];
            expect(firstArg, 'messageQueue.push must receive a first argument').toBeDefined();

            // Two acceptable shapes:
            //   1. Direct string literal: messageQueue.push('继续', ...)
            //   2. Variable holding the literal: const replayText = '继续'; messageQueue.push(replayText, ...)
            // For (2) we walk back to the variable declaration in the same block.
            let resolved: string | null = null;
            if (ts.isStringLiteral(firstArg!) || ts.isNoSubstitutionTemplateLiteral(firstArg!)) {
                resolved = firstArg.text;
            } else if (ts.isIdentifier(firstArg!)) {
                const ident = firstArg.text;
                const decl = findFirstNode(block.thenStatement, (n): n is ts.VariableDeclaration =>
                    ts.isVariableDeclaration(n)
                    && ts.isIdentifier(n.name)
                    && n.name.text === ident
                    && !!n.initializer
                    && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer)),
                );
                if (decl && decl.initializer && (ts.isStringLiteral(decl.initializer) || ts.isNoSubstitutionTemplateLiteral(decl.initializer))) {
                    resolved = decl.initializer.text;
                }
            }
            expect(
                resolved,
                'replay text must be the byte-for-byte literal "继续" (log analysis: 54.6% of users type exactly this string)',
            ).toBe('继续');
        });

        it('calls `recentUserBuffer.record(...)` with the SAME value BEFORE `messageQueue.push(...)`', () => {
            // Mirror of the onUserMessage contract: record → push, never the
            // reverse. If push throws synchronously, an unrecorded prompt is
            // unrecoverable by the next /compact's seed builder.
            expect(block, 'auto-resume block must exist (anchor)').not.toBeNull();
            if (!block) return;
            const records = findMethodCalls(block.thenStatement, 'recentUserBuffer', 'record');
            const pushes = findMethodCalls(block.thenStatement, 'messageQueue', 'push');
            expect(records.length, 'recentUserBuffer.record(...) must be called inside the auto-resume block').toBeGreaterThan(0);
            expect(pushes.length).toBeGreaterThan(0);

            const minRecordPos = Math.min(...records.map((c) => c.getStart(SF)));
            const minPushPos = Math.min(...pushes.map((c) => c.getStart(SF)));
            expect(
                minRecordPos,
                'record must come before push so the replay is recoverable if the next /compact races',
            ).toBeLessThan(minPushPos);

            // record() and push() must reference the same value (identifier or
            // literal text) — otherwise we'd record one thing and push another.
            const recordArg = records[0].arguments[0];
            const pushArg = pushes[0].arguments[0];
            expect(recordArg, 'record must receive a first argument').toBeDefined();
            expect(pushArg, 'push must receive a first argument').toBeDefined();
            expect(recordArg!.getText(SF)).toBe(pushArg!.getText(SF));
        });

        it('the messageQueue.push second argument carries `currentPermissionMode` and `currentModel` (no hardcoded mode/model)', () => {
            // Why this contract is load-bearing: MessageQueue2's modeHasher
            // (verified in runCodexAppServer.regression.test.ts) keys on
            // `permissionMode`. If a future edit hardcodes the replay mode
            // (e.g. `permissionMode: 'default'`), a user who toggled to
            // `bypassPermissions` would see the synthetic "继续" turn execute
            // under the wrong policy AND land in a separate hash bucket from
            // the user's next real message — silent behaviour drift.
            //
            // Accepted shapes (both must reference the live `current*` vars):
            //   1. Inline object literal:
            //        messageQueue.push(text, { permissionMode: currentPermissionMode, model: currentModel })
            //   2. Variable-then-push (current shape):
            //        const replayMode = { permissionMode: currentPermissionMode || 'default', model: currentModel };
            //        messageQueue.push(text, replayMode);
            //
            // We resolve identifiers back to their declared object literal,
            // then assert each property's value expression mentions the
            // corresponding `current*` identifier *somewhere* (lenient on
            // `|| 'default'` style fallbacks).
            expect(block, 'auto-resume block must exist (anchor)').not.toBeNull();
            if (!block) return;
            const pushes = findMethodCalls(block.thenStatement, 'messageQueue', 'push');
            expect(pushes.length).toBeGreaterThan(0);
            const secondArg = pushes[0].arguments[1];
            expect(secondArg, 'messageQueue.push must receive a mode object as second argument').toBeDefined();

            // Resolve to ObjectLiteralExpression — direct or via local var.
            let modeObj: ts.ObjectLiteralExpression | null = null;
            if (secondArg && ts.isObjectLiteralExpression(secondArg)) {
                modeObj = secondArg;
            } else if (secondArg && ts.isIdentifier(secondArg)) {
                const ident = secondArg.text;
                const decl = findFirstNode(block.thenStatement, (n): n is ts.VariableDeclaration =>
                    ts.isVariableDeclaration(n)
                    && ts.isIdentifier(n.name)
                    && n.name.text === ident
                    && !!n.initializer
                    && ts.isObjectLiteralExpression(n.initializer),
                );
                if (decl && decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
                    modeObj = decl.initializer;
                }
            }
            expect(
                modeObj,
                'second argument must resolve to an object literal (either inline or via a local const)',
            ).not.toBeNull();
            if (!modeObj) return;

            const propsByName = new Map<string, ts.Expression>();
            for (const prop of modeObj.properties) {
                if (!ts.isPropertyAssignment(prop)) continue;
                if (!ts.isIdentifier(prop.name)) continue;
                propsByName.set(prop.name.text, prop.initializer);
            }

            const permModeExpr = propsByName.get('permissionMode');
            const modelExpr = propsByName.get('model');
            expect(permModeExpr, 'mode object must have a `permissionMode` field').toBeDefined();
            expect(modelExpr, 'mode object must have a `model` field').toBeDefined();
            if (!permModeExpr || !modelExpr) return;

            // Check whether each value expression references the corresponding
            // `current*` identifier anywhere in its sub-tree. This is lenient
            // toward fallback styles like `currentPermissionMode || 'default'`
            // while still rejecting hardcoded literals.
            const refsIdentifier = (expr: ts.Expression, name: string): boolean => {
                const matches = findAllNodes(expr, (n): n is ts.Identifier =>
                    ts.isIdentifier(n) && n.text === name,
                );
                return matches.length > 0;
            };

            expect(
                refsIdentifier(permModeExpr, 'currentPermissionMode'),
                `\`permissionMode\` value (\`${permModeExpr.getText(SF)}\`) must reference \`currentPermissionMode\` ` +
                `— hardcoding it would make the synthetic turn execute under the wrong policy and land in a ` +
                `different MessageQueue2 batch from the user's next message.`,
            ).toBe(true);
            expect(
                refsIdentifier(modelExpr, 'currentModel'),
                `\`model\` value (\`${modelExpr.getText(SF)}\`) must reference \`currentModel\` ` +
                `— hardcoding it would pin the replay turn to a stale or wrong model.`,
            ).toBe(true);
        });
    });

    describe('manual /compact must NOT auto-resume', () => {
        it('every `messageQueue.push(...)` inside runManualCompact lives under the autoTriggered guard', () => {
            // Negative contract: if someone later adds an unconditional push
            // (or moves the existing one outside the if-block) the manual
            // /compact UX silently changes — users who typed /compact would
            // suddenly see "继续" auto-injected. The commit message is
            // explicit: "Manual /compact stays user-driven; only autoTriggered
            // path replays."
            const compactFn = findRunManualCompact();
            expect(compactFn, 'runManualCompact must exist (anchor)').not.toBeNull();
            if (!compactFn) return;

            const guardBlock = findAutoResumeIfBlock();
            const pushesInFn = findMethodCalls(compactFn, 'messageQueue', 'push');

            for (const push of pushesInFn) {
                const pushPos = push.getStart(SF);
                // Walk up the AST: every push position must lie inside the
                // guard block's range. If the guard doesn't exist yet, every
                // push is a violation.
                expect(
                    guardBlock,
                    `messageQueue.push found inside runManualCompact at offset ${pushPos} but the auto-resume guard block is missing`,
                ).not.toBeNull();
                if (!guardBlock) return;
                const guardStart = guardBlock.getStart(SF);
                const guardEnd = guardBlock.getEnd();
                expect(
                    pushPos >= guardStart && pushPos < guardEnd,
                    `messageQueue.push at offset ${pushPos} (L${SF.getLineAndCharacterOfPosition(pushPos).line + 1}) ` +
                    `is OUTSIDE the autoTriggered guard block (${guardStart}-${guardEnd}). ` +
                    `Manual /compact would now auto-replay — restore the guard.`,
                ).toBe(true);
            }
        });
    });

    describe('positional contract — auto-resume runs AFTER seed is stashed', () => {
        // The replay only makes sense once the next turn will pick up the
        // stashed seed. Three anchor points must obey A < B < C:
        //   A: compactState.pendingSeedText = seedText   (seed committed)
        //   B: sendSessionEvent({ type: 'ready' })       (loop unblocked)
        //   C: messageQueue.push('继续', ...)            (replay)
        // And C must precede:
        //   D: compactInFlight = false                   (critical section exit)
        // — so the replay is enqueued while the lock is still held, preventing
        // a second /compact from snatching the queue before our replay lands.
        it('replay push falls between `pendingSeedText = seedText` and `compactInFlight = false`', () => {
            const compactFn = findRunManualCompact();
            expect(compactFn, 'runManualCompact must exist (anchor)').not.toBeNull();
            if (!compactFn) return;

            const seedAssign = findFirstNode(compactFn, (n): n is ts.BinaryExpression =>
                ts.isBinaryExpression(n)
                && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
                && ts.isPropertyAccessExpression(n.left)
                && ts.isIdentifier(n.left.expression)
                && n.left.expression.text === 'compactState'
                && n.left.name.text === 'pendingSeedText',
            );
            const inFlightFalse = findFirstNode(compactFn, (n): n is ts.BinaryExpression =>
                ts.isBinaryExpression(n)
                && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
                && ts.isIdentifier(n.left)
                && n.left.text === 'compactInFlight'
                && n.right.kind === ts.SyntaxKind.FalseKeyword,
            );
            const pushes = findMethodCalls(compactFn, 'messageQueue', 'push');

            expect(seedAssign, 'A: `compactState.pendingSeedText = seedText` must exist').not.toBeNull();
            expect(inFlightFalse, 'D: `compactInFlight = false` must exist').not.toBeNull();
            expect(pushes.length, 'C: messageQueue.push inside runManualCompact must exist').toBeGreaterThan(0);
            if (!seedAssign || !inFlightFalse) return;

            const posA = seedAssign.getStart(SF);
            const posD = inFlightFalse.getStart(SF);
            // Every push must obey A < push-position < D. Equivalent to
            // "lives in the critical section, after the seed has been
            // committed".
            for (const push of pushes) {
                const posC = push.getStart(SF);
                expect(
                    posA < posC,
                    `replay push at offset ${posC} must come AFTER seed assignment at ${posA} ` +
                    `— otherwise the next turn fires before the seed is in pendingSeedText`,
                ).toBe(true);
                expect(
                    posC < posD,
                    `replay push at offset ${posC} must come BEFORE compactInFlight=false at ${posD} ` +
                    `— otherwise a concurrent /compact could drain the queue first`,
                ).toBe(true);
            }
        });

        it('replay push falls AFTER the `ready` session event so happy-app sees the unblock first', () => {
            const compactFn = findRunManualCompact();
            expect(compactFn, 'runManualCompact must exist (anchor)').not.toBeNull();
            if (!compactFn) return;

            // We want the FINAL ready emission inside runManualCompact (there
            // are early-return readys at the top of the function for the
            // "in-flight / no client / no thread" guards). Pick the last
            // ready call whose offset is < the replay push offset.
            const readyCalls = findAllNodes(compactFn, (n): n is ts.CallExpression => {
                if (!ts.isCallExpression(n)) return false;
                if (!ts.isPropertyAccessExpression(n.expression)) return false;
                if (n.expression.name.text !== 'sendSessionEvent') return false;
                const arg = n.arguments[0];
                if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
                // Match { type: 'ready' }
                return arg.properties.some(
                    (p) =>
                        ts.isPropertyAssignment(p)
                        && ts.isIdentifier(p.name)
                        && p.name.text === 'type'
                        && ts.isStringLiteral(p.initializer)
                        && p.initializer.text === 'ready',
                );
            });
            const pushes = findMethodCalls(compactFn, 'messageQueue', 'push');
            expect(readyCalls.length, 'at least one `sendSessionEvent({type:"ready"})` must exist').toBeGreaterThan(0);
            expect(pushes.length).toBeGreaterThan(0);

            const earliestPush = Math.min(...pushes.map((p) => p.getStart(SF)));
            const precedingReadys = readyCalls.filter((r) => r.getStart(SF) < earliestPush);
            expect(
                precedingReadys.length,
                'at least one ready event must precede the replay push so the client unblocks before the synthetic turn fires',
            ).toBeGreaterThan(0);
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // Runtime sanity: on a real, large ~/.codex rollout, the heuristic seed
    // builder produces a valid non-empty seed. The auto-resume only matters
    // when this path succeeds — if the seed builder errored on big rollouts,
    // the replay would push "继续" into a brand-new threadless conversation.
    // ───────────────────────────────────────────────────────────────────────
    describe('real-rollout fallback path (uses ~/.codex sessions)', () => {
        const codexSessionsRoot = resolve(homedir(), '.codex', 'sessions');

        let largestRollout: { path: string; size: number } | null = null;
        try {
            // Use git-bash compatible find (works on Windows because git-bash
            // ships with it). On platforms without git-bash, the try/catch
            // skips the test cleanly.
            const out = execSync(
                `find "${codexSessionsRoot.replace(/\\/g, '/')}" -name "*.jsonl" -type f -printf '%s %p\\n' 2>/dev/null | sort -rn | head -1`,
                { encoding: 'utf8', shell: 'C:\\Program Files\\Git\\bin\\bash.exe', windowsHide: true },
            ).trim();
            if (out) {
                const m = out.match(/^(\d+)\s+(.+)$/);
                if (m) {
                    const path = m[2].replace(/^\/[a-z]\//, (s) => s[1].toUpperCase() + ':\\').replace(/\//g, '\\');
                    if (statSync(path).isFile()) {
                        largestRollout = { path, size: Number(m[1]) };
                    }
                }
            }
        } catch {
            // git-bash / find not available — leave largestRollout null and
            // the test will skip with a descriptive message instead of failing
            // in CI environments that don't have ~/.codex sessions.
        }

        it('buildHeuristicSeed produces a non-empty seed on the largest available real rollout (or skips if none)', async () => {
            if (!largestRollout) {
                console.warn('[autoResumeAfterFallback] no ~/.codex rollouts found — skipping real-rollout sanity check');
                return;
            }

            const { seedText, stats } = await buildHeuristicSeed({
                rolloutPath: largestRollout.path,
                trailerNote: '请基于以上摘要继续。',
                extraUserTexts: [],
            });

            // The exact size/content of the seed is not asserted — we only
            // care that the fallback path doesn't throw, returns a seed, and
            // that the seed contains at least one turn. These are the
            // pre-conditions for the auto-resume "继续" to land meaningfully
            // in the next thread.
            expect(seedText.length, `seed must be non-empty for rollout ${largestRollout.path}`).toBeGreaterThan(0);
            expect(stats.userTurns, `expected at least one user turn in seed for ${largestRollout.size}-byte rollout`).toBeGreaterThan(0);
            // The seed should reference the must-keep recent block heading,
            // which is the load-bearing region the auto-resume "继续" will
            // ride on top of.
            expect(seedText).toContain('最近');
        }, 30_000);
    });
});
