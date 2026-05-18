/**
 * Shared TypeScript AST traversal helpers for the codex __tests__ suite.
 *
 * Sole purpose: avoid duplicating tree-walk boilerplate between the AST-level
 * regression tests for `runCodexAppServer.ts`. Each helper is pure (no global
 * state, no project-file dependencies) so a future test file can pick it up
 * without import cycles against the very source it parses.
 *
 * Naming intentionally generic (`findFirstNode`, `findAllNodes`,
 * `findMethodCalls`) — these are not specific to runCodexAppServer or to any
 * one regression contract.
 */

import * as ts from 'typescript';

/** Depth-first search; returns the FIRST node matching `predicate`, or null. */
export function findFirstNode<T extends ts.Node>(
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

/** Depth-first search; returns ALL nodes matching `predicate`. */
export function findAllNodes<T extends ts.Node>(
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

/**
 * Find every `<obj>.<method>(...)` call expression in a subtree.
 *
 * Matches only direct property-access calls — does NOT match
 * `aliased.method()` where `aliased` was destructured from `<obj>`.
 * That's deliberate: callers want to anchor on a specific receiver
 * identifier visible in the source.
 */
export function findMethodCalls(
    root: ts.Node,
    obj: string,
    method: string,
): ts.CallExpression[] {
    return findAllNodes(root, (n): n is ts.CallExpression =>
        ts.isCallExpression(n)
        && ts.isPropertyAccessExpression(n.expression)
        && ts.isIdentifier(n.expression.expression)
        && n.expression.expression.text === obj
        && n.expression.name.text === method,
    );
}
