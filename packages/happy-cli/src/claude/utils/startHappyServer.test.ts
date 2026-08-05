import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { startHappyServer } from './startHappyServer';

describe('Happy title MCP authority', () => {
    it('externally managed Happy title rejects model mutation before summary emission', async () => {
        const prior = process.env.HAPPY_TITLE_AUTHORITY;
        const messages: unknown[] = [];
        process.env.HAPPY_TITLE_AUTHORITY = 'external';
        const server = await startHappyServer({
            sessionId: 'title-authority-test',
            sendClaudeSessionMessage: (message: unknown) => { messages.push(message); },
        } as unknown as ApiSessionClient);
        const client = new Client({ name: 'title-authority-test', version: '1' }, { capabilities: {} });
        try {
            await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
            const blocked = await client.callTool({ name: 'change_title', arguments: { title: 'blocked' } });
            expect(blocked.isError).toBe(true);
            expect(messages).toEqual([]);
        } finally {
            await client.close();
            server.stop();
            if (prior === undefined) delete process.env.HAPPY_TITLE_AUTHORITY;
            else process.env.HAPPY_TITLE_AUTHORITY = prior;
        }
    });
});
