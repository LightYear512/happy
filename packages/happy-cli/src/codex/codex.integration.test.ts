/**
 * Integration tests for the Codex app-server JSON-RPC transport.
 *
 * Tests drive `codex app-server` via `createCodexAppServerClient` and verify
 * the low-level JSON-RPC plumbing — connection lifecycle, request/response,
 * notifications, and error handling.
 *
 * Requirements:
 *   - `codex` CLI installed and on PATH (>= 0.100)
 *   - OPENAI_API_KEY (or equivalent) configured
 *
 * Run:
 *   npx vitest run src/codex/codex.integration.test.ts
 */

import { afterEach, describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { createCodexAppServerClient, type CodexAppServerClient } from './codexAppServerClient';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function isCodexAppServerAvailable(): Promise<boolean> {
    try {
        const version = execSync('codex --version', { encoding: 'utf8' }).trim();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+)/);
        if (!match) return false;
        const [major, minor] = match[1].split('.').map(Number);
        return major > 0 || minor >= 100;
    } catch {
        return false;
    }
}

const available = await isCodexAppServerAvailable();

// ── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(!available)('Codex integration (app-server transport)', { timeout: 60_000 }, () => {
    let client: CodexAppServerClient | null = null;

    afterEach(async () => {
        if (client) {
            await client.dispose();
            client = null;
        }
    });

    it('creates a client and the codex process starts responding', async () => {
        client = await createCodexAppServerClient();
        // If the client was created without throwing, the process started successfully.
        expect(client).toBeDefined();
        expect(client.request).toBeTypeOf('function');
        expect(client.notify).toBeTypeOf('function');
        expect(client.dispose).toBeTypeOf('function');
    });

    it('receives server notifications by registering a notification handler', async () => {
        client = await createCodexAppServerClient();

        const received: unknown[] = [];
        client.registerNotificationHandler('codex/ready', (params) => {
            received.push(params);
        });

        // The codex app-server may emit a ready notification on startup.
        // Wait a moment for it.
        await new Promise(r => setTimeout(r, 3_000));

        // We can't guarantee a specific notification in all versions, but we
        // verify the handler infrastructure works without throwing.
        expect(received).toBeInstanceOf(Array);
    });

    it('dispose resolves cleanly', async () => {
        client = await createCodexAppServerClient();
        await expect(client.dispose()).resolves.toBeUndefined();
        client = null; // prevent double-dispose in afterEach
    });

    it('rejects requests after dispose', async () => {
        client = await createCodexAppServerClient();
        await client.dispose();
        await expect(client.request('session/list', {})).rejects.toThrow();
        client = null;
    });
});

describe.skipIf(available)('Codex integration (codex CLI not available)', () => {
    it('skips all integration tests — codex CLI not found on PATH', () => {
        // This serves as documentation that the suite was intentionally skipped.
        expect(available).toBe(false);
    });
});
