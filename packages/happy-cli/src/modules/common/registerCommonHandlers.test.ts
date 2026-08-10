import { describe, expect, it } from 'vitest';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerCommonHandlers } from './registerCommonHandlers';

const key = new Uint8Array(32);

async function callRipgrep(args: string[]) {
    const manager = new RpcHandlerManager({
        scopePrefix: 'test',
        encryptionKey: key,
        encryptionVariant: 'dataKey',
        logger: () => {},
    });
    registerCommonHandlers(manager, process.cwd());
    const response = await manager.handleRequest({
        method: 'test:ripgrep',
        params: encodeBase64(encrypt(key, 'dataKey', { args })),
    });
    return decrypt(key, 'dataKey', decodeBase64(response));
}

describe('ripgrep RPC capacity boundary', () => {
    it('rejects full repository discovery and preserves ordinary ripgrep', async () => {
        await expect(callRipgrep(['--files', '--follow'])).resolves.toEqual({
            success: false,
            error: 'Full repository file discovery is disabled',
        });
        await expect(callRipgrep(['--follow', '--files'])).resolves.toEqual({
            success: false,
            error: 'Full repository file discovery is disabled',
        });
        await expect(callRipgrep(['--version'])).resolves.toMatchObject({
            success: true,
            exitCode: 0,
        });
    });
});
