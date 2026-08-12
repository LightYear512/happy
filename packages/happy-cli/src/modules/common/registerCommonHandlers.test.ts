import { describe, expect, it } from 'vitest';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerCommonHandlers } from './registerCommonHandlers';

const key = new Uint8Array(32);

function manager(): RpcHandlerManager {
    const value = new RpcHandlerManager({
        scopePrefix: 'test',
        encryptionKey: key,
        encryptionVariant: 'dataKey',
        logger: () => {},
    });
    registerCommonHandlers(value, process.cwd());
    return value;
}

async function callBash(command: string) {
    const response = await manager().handleRequest({
        method: 'test:bash',
        params: encodeBase64(encrypt(key, 'dataKey', { command })),
    });
    return decrypt(key, 'dataKey', decodeBase64(response));
}

async function call(method: string) {
    const response = await manager().handleRequest({
        method: `test:${method}`,
        params: encodeBase64(encrypt(key, 'dataKey', {})),
    });
    return decrypt(key, 'dataKey', decodeBase64(response));
}

describe('common RPC surface', () => {
    it('keeps repository/file RPC identities as one explicit disabled boundary', async () => {
        const value = manager();
        expect(value.hasHandler('bash')).toBe(true);
        for (const method of ['readFile', 'writeFile', 'listDirectory', 'getDirectoryTree', 'ripgrep', 'difftastic']) {
            expect(value.hasHandler(method)).toBe(true);
            await expect(call(method)).resolves.toEqual({
                success: false,
                error: 'Repository file access is disabled in this Happy client',
            });
        }
    });

    it('fails only the overflowing bash call at the explicit one-mebibyte bound', async () => {
        await expect(callBash(`node -e "process.stdout.write('x'.repeat(2*1024*1024))"`)).resolves.toEqual({
            success: false,
            exitCode: -1,
            error: 'Command output exceeded 1 MiB limit',
        });
        await expect(callBash(`node -e "process.stdout.write('ok')"`)).resolves.toMatchObject({
            success: true,
            stdout: 'ok',
        });
    });
});
