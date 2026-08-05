import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ioMock, socket, makeSocket, getMock, isAxiosErrorMock, decryptMock, encryptMock } = vi.hoisted(() => {
    const makeSocket = () => {
        const handlers = new Map<string, (...args: any[]) => void>();
        const listeners = new Map<string, (...args: any[]) => void>();
        return {
            connected: false,
            connect: vi.fn(),
            close: vi.fn(),
            emit: vi.fn(),
            on: vi.fn((name: string, handler: (...args: any[]) => void) => listeners.set(name, handler)),
            once: vi.fn((name: string, handler: (...args: any[]) => void) => handlers.set(name, handler)),
            off: vi.fn(),
            __handlers: handlers,
            __listeners: listeners,
        };
    };
    const socket = makeSocket();
    return {
        ioMock: vi.fn((..._args: any[]) => socket),
        socket,
        makeSocket,
        getMock: vi.fn(),
        isAxiosErrorMock: vi.fn(() => false),
        decryptMock: vi.fn(() => ({
            role: 'user', content: { type: 'text', text: 'hello' }, meta: { sentFrom: 'cli' },
        } as any)),
        encryptMock: vi.fn(() => new Uint8Array([1, 2, 3])),
    };
});

vi.mock('socket.io-client', () => ({ io: ioMock }));
vi.mock('axios', () => ({
    default: { get: getMock, isAxiosError: isAxiosErrorMock },
}));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'https://happy.test' } }));
vi.mock('./encryption', () => ({
    encrypt: encryptMock,
    encodeBase64: vi.fn(() => 'encrypted-user-message'),
    decodeBase64: vi.fn(() => new Uint8Array([1, 2, 3])),
    decrypt: decryptMock,
}));

import { ApiSessionMessageClient, sendAgentEventOnce, sendCodexMessageOnce, sendUserMessageOnce } from './apiSessionMessage';

const session = {
    id: 'session-1',
    seq: 1,
    encryptionKey: new Uint8Array(32),
    encryptionVariant: 'dataKey' as const,
    metadata: {} as any,
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
};
const localId = `xc-msg-v1-${'a'.repeat(64)}`;

describe('ApiSessionMessageClient', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ioMock.mockReset().mockReturnValue(socket);
        socket.connected = false;
        socket.__handlers.clear();
        socket.__listeners.clear();
        getMock.mockReset();
        isAxiosErrorMock.mockReset().mockReturnValue(false);
        decryptMock.mockReset().mockReturnValue({
            role: 'user', content: { type: 'text', text: 'hello' }, meta: { sentFrom: 'cli' },
        });
        encryptMock.mockReset().mockReturnValue(new Uint8Array([1, 2, 3]));
    });

    it('does not create a socket before request admission and preflight', async () => {
        const client = new ApiSessionMessageClient('secret-token', session);
        expect(client).toBeDefined();
        expect(ioMock).not.toHaveBeenCalled();
    });

    it('MNA-055 rejects invalid localId and timeout before socket creation', async () => {
        const invalidLocalId = {
            messageRole: 'user', messageText: 'hello', localId: 'bad', timeoutMs: 10_000,
        } as const;
        expect(() => ApiSessionMessageClient.validateRequest(invalidLocalId)).toThrow(/localId/);
        expect(() => ApiSessionMessageClient.validateRequest({
            messageRole: 'user', messageText: 'hello', localId, timeoutMs: 0,
        })).toThrow(/timeout/);
        await expect(sendUserMessageOnce('secret-token', session, invalidLocalId)).rejects.toThrow(/localId/);
        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendUserMessageOnce(invalidLocalId)).rejects.toThrow(/localId/);
        expect(ioMock).not.toHaveBeenCalled();
    });

    it('accepts the exact XC soft-notification localId namespace', () => {
        const softLocalId = `xc-soft-v1-${'b'.repeat(64)}`;
        expect(ApiSessionMessageClient.validateRequest({
            messageRole: 'user', messageText: 'soft check', localId: softLocalId, timeoutMs: 10_000,
        }).localId).toBe(softLocalId);
        for (const invalid of [
            `xc-soft-v2-${'b'.repeat(64)}`,
            `xc-soft-v1-${'b'.repeat(63)}`,
            `xc-soft-v1-${'B'.repeat(64)}`,
        ]) expect(() => ApiSessionMessageClient.validateRequest({
            messageRole: 'user', messageText: 'soft check', localId: invalid, timeoutMs: 10_000,
        })).toThrow(/localId/);
        expect(() => ApiSessionMessageClient.validateCodexRequest({
            messageRole: 'agent', messageType: 'codex', body: { message: 'soft check' },
            localId: softLocalId, timeoutMs: 10_000,
        })).toThrow(/localId/);
        expect(() => ApiSessionMessageClient.validateAgentEventRequest({
            messageRole: 'agent', messageType: 'event', message: 'soft check', eventId: 'soft-check',
            localId: softLocalId, timeoutMs: 10_000,
        })).toThrow(/localId/);
        expect(ioMock).not.toHaveBeenCalled();
    });

    it('persists a compact Mail event through the same bounded one-shot writer', async () => {
        const observer = makeSocket();
        const writer = makeSocket();
        observer.connected = true;
        writer.connected = true;
        ioMock.mockReset().mockReturnValueOnce(observer).mockReturnValueOnce(writer);
        const row = { id: 'agent-event-1', seq: 18, localId, createdAt: 12346,
            content: { t: 'encrypted', c: 'ciphertext' } };
        decryptMock.mockReturnValue({ role: 'agent', content: { id: 'restore-event-1', type: 'event',
            data: { type: 'compact-message', message: '📤 x-000042 MixedCase 邮件标题' } } });
        getMock.mockResolvedValue({ data: { messages: [] } });
        writer.emit.mockImplementation((event: string) => {
            if (event === 'message') {
                observer.__listeners.get('update')?.({ body: { t: 'new-message', sid: session.id, message: row } });
            }
        });

        await expect(sendAgentEventOnce('secret-token', session, {
            messageRole: 'agent', messageType: 'event', message: '📤 x-000042 MixedCase 邮件标题',
            eventId: 'restore-event-1', localId, timeoutMs: 10_000, presentation: 'compact',
        })).resolves.toEqual({ result: 'success', id: row.id, seq: row.seq, localId, createdAt: row.createdAt });
        expect(encryptMock).toHaveBeenCalledWith(session.encryptionKey, session.encryptionVariant,
            { role: 'agent', content: { id: 'restore-event-1', type: 'event',
                data: { type: 'compact-message', message: '📤 x-000042 MixedCase 邮件标题' } } });
        expect(observer.close).toHaveBeenCalledOnce();
        expect(writer.close).toHaveBeenCalledOnce();
    });

    it('auxiliary user message rejects invalid permission mode before socket creation', async () => {
        const invalid = {
            messageRole: 'user', messageText: 'hello', localId, timeoutMs: 10_000,
            permissionMode: 'unsafe-unknown-mode',
        } as any;
        expect(() => ApiSessionMessageClient.validateRequest(invalid)).toThrow(/permissionMode/);
        await expect(sendUserMessageOnce('secret-token', session, invalid)).rejects.toThrow(/permissionMode/);
        expect(ioMock).not.toHaveBeenCalled();
    });

    it('auxiliary user message rejects an unknown presentation before socket creation', async () => {
        const invalid = {
            messageRole: 'user', messageText: 'hello', localId, timeoutMs: 10_000,
            presentation: 'forged',
        } as any;
        expect(() => ApiSessionMessageClient.validateRequest(invalid)).toThrow(/presentation/);
        await expect(sendUserMessageOnce('secret-token', session, invalid)).rejects.toThrow(/presentation/);
        expect(ioMock).not.toHaveBeenCalled();
    });

    it.each(['one line', 'first\n\nthird'])(
        'Mail presentation rejects a malformed two-line display before socket creation',
        async (displayText) => {
            const invalid = {
                messageRole: 'user', messageText: 'full model context', displayText,
                presentation: 'mail', localId, timeoutMs: 10_000,
            } as const;
            expect(() => ApiSessionMessageClient.validateRequest(invalid)).toThrow(/Mail presentation/);
            await expect(sendUserMessageOnce('secret-token', session, invalid)).rejects.toThrow(/Mail presentation/);
            expect(ioMock).not.toHaveBeenCalled();
        },
    );

    it('agent event rejects an unknown presentation before socket creation', async () => {
        const invalid = {
            messageRole: 'agent', messageType: 'event', message: 'event', eventId: 'event-1',
            presentation: 'mail', localId, timeoutMs: 10_000,
        } as any;
        expect(() => ApiSessionMessageClient.validateAgentEventRequest(invalid)).toThrow(/presentation/);
        await expect(sendAgentEventOnce('secret-token', session, invalid)).rejects.toThrow(/presentation/);
        expect(ioMock).not.toHaveBeenCalled();
    });

    it('auxiliary user message rejects oversized text before socket creation', async () => {
        const invalid = {
            messageRole: 'user', messageText: 'x'.repeat(12_001), localId, timeoutMs: 10_000,
        } as const;
        expect(() => ApiSessionMessageClient.validateRequest(invalid)).toThrow(/messageText size/);
        await expect(sendUserMessageOnce('secret-token', session, invalid)).rejects.toThrow(/messageText size/);
        expect(ioMock).not.toHaveBeenCalled();
    });

    it.each(['', 'x'.repeat(12_001)])('auxiliary user message rejects invalid display text before socket creation', async (displayText) => {
        const invalid = {
            messageRole: 'user', messageText: 'full model context', displayText, localId, timeoutMs: 10_000,
        } as const;
        expect(() => ApiSessionMessageClient.validateRequest(invalid)).toThrow(/displayText/);
        await expect(sendUserMessageOnce('secret-token', session, invalid)).rejects.toThrow(/displayText/);
        expect(ioMock).not.toHaveBeenCalled();
    });

    it('returns the exact persisted row from the existing query API and closes its own socket', async () => {
        const row = { id: 'message-1', seq: 17, localId, createdAt: 12345, content: { t: 'encrypted', c: 'ciphertext' } };
        socket.connected = true;
        getMock
            .mockResolvedValueOnce({ data: { messages: [] } })
            .mockResolvedValueOnce({ data: { messages: [row] } });
        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendUserMessageOnce({ messageRole: 'user', messageText: 'hello', localId, timeoutMs: 10_000 })).resolves.toEqual({ result: 'success', id: row.id, seq: row.seq, localId, createdAt: row.createdAt });
        expect(ioMock).toHaveBeenCalledWith('https://happy.test', expect.objectContaining({
            auth: { token: 'secret-token', clientType: 'user-scoped' },
            reconnection: false,
            autoConnect: false,
        }));
        expect(socket.emit).toHaveBeenCalledWith('message', expect.objectContaining({ sid: 'session-1', localId }));
        expect(socket.close).toHaveBeenCalledOnce();
    });

    it('encrypts and confirms the admitted permission mode on a user message', async () => {
        const row = { id: 'message-mode', seq: 18, localId, createdAt: 12346, content: { t: 'encrypted', c: 'ciphertext' } };
        socket.connected = true;
        decryptMock.mockReturnValue({
            role: 'user', content: { type: 'text', text: 'hello' },
            meta: { sentFrom: 'cli', permissionMode: 'yolo' },
        });
        getMock
            .mockResolvedValueOnce({ data: { messages: [] } })
            .mockResolvedValueOnce({ data: { messages: [row] } });

        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendUserMessageOnce({
            messageRole: 'user', messageText: 'hello', localId, timeoutMs: 10_000, permissionMode: 'yolo',
        })).resolves.toMatchObject({ result: 'success', id: row.id, localId });

        expect(encryptMock).toHaveBeenCalledWith(
            session.encryptionKey,
            session.encryptionVariant,
            expect.objectContaining({ meta: { sentFrom: 'cli', permissionMode: 'yolo' } }),
        );
    });

    it('persists the compact legacy-client text while binding full model text in encrypted metadata', async () => {
        const row = { id: 'message-compact', seq: 19, localId, createdAt: 12347, content: { t: 'encrypted', c: 'ciphertext' } };
        socket.connected = true;
        decryptMock.mockReturnValue({
            role: 'user', content: { type: 'text', text: 'compact summary' },
            meta: { sentFrom: 'cli', modelText: 'full model context',
                displayText: 'compact summary', presentation: 'compact' },
        });
        getMock
            .mockResolvedValueOnce({ data: { messages: [] } })
            .mockResolvedValueOnce({ data: { messages: [row] } });

        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendUserMessageOnce({
            messageRole: 'user', messageText: 'full model context', displayText: 'compact summary',
            localId, timeoutMs: 10_000, presentation: 'compact',
        })).resolves.toMatchObject({ result: 'success', id: row.id, localId });

        expect(encryptMock).toHaveBeenCalledWith(
            session.encryptionKey,
            session.encryptionVariant,
            expect.objectContaining({
                content: { type: 'text', text: 'compact summary' },
                meta: { sentFrom: 'cli', modelText: 'full model context',
                    displayText: 'compact summary', presentation: 'compact' },
            }),
        );
    });

    it('persists the received Mail card while binding full model text in encrypted metadata', async () => {
        const row = { id: 'message-mail', seq: 20, localId, createdAt: 12348,
            content: { t: 'encrypted', c: 'ciphertext' } };
        socket.connected = true;
        decryptMock.mockReturnValue({
            role: 'user', content: { type: 'text', text: 'x-000028 01:19\nMixedCase 邮件标题' },
            meta: { sentFrom: 'cli', modelText: 'full model context',
                displayText: 'x-000028 01:19\nMixedCase 邮件标题', presentation: 'mail' },
        });
        getMock
            .mockResolvedValueOnce({ data: { messages: [] } })
            .mockResolvedValueOnce({ data: { messages: [row] } });

        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendUserMessageOnce({
            messageRole: 'user', messageText: 'full model context',
            displayText: 'x-000028 01:19\nMixedCase 邮件标题',
            localId, timeoutMs: 10_000, presentation: 'mail',
        })).resolves.toMatchObject({ result: 'success', id: row.id, localId });

        expect(encryptMock).toHaveBeenCalledWith(
            session.encryptionKey,
            session.encryptionVariant,
            expect.objectContaining({
                content: { type: 'text', text: 'x-000028 01:19\nMixedCase 邮件标题' },
                meta: { sentFrom: 'cli', modelText: 'full model context',
                    displayText: 'x-000028 01:19\nMixedCase 邮件标题', presentation: 'mail' },
            }),
        );
    });

    it('returns an existing localId without connecting or emitting again', async () => {
        const row = { id: 'message-1', seq: 17, localId, createdAt: 12345, content: { t: 'encrypted', c: 'ciphertext' } };
        getMock.mockResolvedValue({ data: { messages: [row] } });
        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendUserMessageOnce({ messageRole: 'user', messageText: 'hello', localId, timeoutMs: 10_000 })).resolves.toEqual({ result: 'success', id: row.id, seq: row.seq, localId, createdAt: row.createdAt });
        expect(socket.connect).not.toHaveBeenCalled();
        expect(socket.emit).not.toHaveBeenCalled();
        expect(socket.close).not.toHaveBeenCalled();
    });

    it('rejects an existing localId whose decrypted payload differs', async () => {
        const row = { id: 'message-1', seq: 17, localId, createdAt: 12345, content: { t: 'encrypted', c: 'ciphertext' } };
        decryptMock.mockReturnValue({ role: 'user', content: { type: 'text', text: 'different' } });
        getMock.mockResolvedValue({ data: { messages: [row] } });
        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendUserMessageOnce({ messageRole: 'user', messageText: 'hello', localId, timeoutMs: 10_000 })).rejects.toThrow(/payload mismatch/);
        expect(socket.connect).not.toHaveBeenCalled();
        expect(socket.emit).not.toHaveBeenCalled();
        expect(socket.close).not.toHaveBeenCalled();
    });

    it('persisted user message confirmation binds permission mode', async () => {
        const row = { id: 'message-1', seq: 17, localId, createdAt: 12345, content: { t: 'encrypted', c: 'ciphertext' } };
        decryptMock.mockReturnValue({
            role: 'user', content: { type: 'text', text: 'hello' },
            meta: { sentFrom: 'cli', permissionMode: 'default' },
        });
        getMock.mockResolvedValue({ data: { messages: [row] } });
        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendUserMessageOnce({
            messageRole: 'user', messageText: 'hello', localId, timeoutMs: 10_000, permissionMode: 'yolo',
        })).rejects.toThrow(/payload mismatch/);
        expect(socket.connect).not.toHaveBeenCalled();
        expect(socket.emit).not.toHaveBeenCalled();
    });

    it.each([
        [{ id: 'x'.repeat(129), seq: 17, createdAt: 12345 }, /id invalid/],
        [{ id: 'message-1', seq: 17, createdAt: 8_640_000_000_000_001 }, /createdAt invalid/],
    ])('MNA-054 rejects malformed persisted identity fields before claiming success', async (identity, error) => {
        const row = { ...identity, localId, content: { t: 'encrypted', c: 'ciphertext' } };
        getMock.mockResolvedValue({ data: { messages: [row] } });
        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendUserMessageOnce({ messageRole: 'user', messageText: 'hello', localId, timeoutMs: 10_000 })).rejects.toThrow(error);
        expect(socket.connect).not.toHaveBeenCalled();
        expect(socket.emit).not.toHaveBeenCalled();
        expect(socket.close).not.toHaveBeenCalled();
    });

    it('persisted user message confirmation binds display text and compact presentation', async () => {
        const row = { id: 'message-1', seq: 17, localId, createdAt: 12345, content: { t: 'encrypted', c: 'ciphertext' } };
        decryptMock.mockReturnValue({
            role: 'user', content: { type: 'text', text: 'compact summary' },
            meta: { sentFrom: 'cli', modelText: 'hello',
                displayText: 'different summary', presentation: 'compact' },
        });
        getMock.mockResolvedValue({ data: { messages: [row] } });
        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendUserMessageOnce({
            messageRole: 'user', messageText: 'hello', displayText: 'compact summary',
            localId, timeoutMs: 10_000, presentation: 'compact',
        })).rejects.toThrow(/payload mismatch/);
        expect(socket.connect).not.toHaveBeenCalled();
        expect(socket.emit).not.toHaveBeenCalled();
    });

    it('uses the same monotonic deadline for connect and read-back confirmation', async () => {
        getMock.mockResolvedValue({ data: { messages: [] } });
        socket.connected = true;
        const client = new ApiSessionMessageClient('secret-token', session);
        const promise = client.sendUserMessageOnce({ messageRole: 'user', messageText: 'hello', localId, timeoutMs: 20 });
        await expect(promise).rejects.toThrow(/deadline/);
        expect(socket.close).toHaveBeenCalledOnce();
    });

    it('MNA-056 does not create a socket when preflight exhausts the shared deadline', async () => {
        getMock.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ data: { messages: [] } }), 20)));
        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendUserMessageOnce({ messageRole: 'user', messageText: 'hello', localId, timeoutMs: 5 })).rejects.toThrow(/deadline/);
        expect(ioMock).not.toHaveBeenCalled();
        expect(socket.close).not.toHaveBeenCalled();
    });

    it('fails closed on a malformed message collection before emitting', async () => {
        getMock.mockResolvedValue({ data: { messages: { invalid: true } } });
        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendUserMessageOnce({ messageRole: 'user', messageText: 'hello', localId, timeoutMs: 10_000 })).rejects.toThrow(/message collection/);
        expect(socket.connect).not.toHaveBeenCalled();
        expect(socket.emit).not.toHaveBeenCalled();
        expect(socket.close).not.toHaveBeenCalled();
    });

    it('HSR rejects a confirmation query larger than the deployed recent window', async () => {
        getMock.mockResolvedValue({ data: { messages: Array.from({ length: 151 }, () => ({})) } });
        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendUserMessageOnce({
            messageRole: 'user', messageText: 'hello', localId, timeoutMs: 10_000,
        })).rejects.toThrow(/message collection/);
        expect(ioMock).not.toHaveBeenCalled();
    });

    it('bounds recent-window confirmation without claiming recovery for an evicted row', async () => {
        const recentRows = Array.from({ length: 150 }, (_, index) => ({
            id: `other-${index}`,
            seq: index + 1,
            localId: `other-${index}`,
            createdAt: 12345 + index,
            content: { t: 'encrypted', c: 'ciphertext' },
        }));
        getMock.mockResolvedValue({ data: { messages: recentRows } });
        socket.connected = true;
        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendUserMessageOnce({ messageRole: 'user', messageText: 'hello', localId, timeoutMs: 20 })).rejects.toThrow(/deadline/);
        expect(socket.emit).toHaveBeenCalledTimes(1);
        expect(socket.close).toHaveBeenCalledOnce();
    });

    it('HSR sends one exact Codex message through distinct user-scoped observer and writer sockets', async () => {
        const observer = makeSocket();
        const writer = makeSocket();
        observer.connected = true;
        writer.connected = true;
        ioMock.mockReset().mockReturnValueOnce(observer).mockReturnValueOnce(writer);
        const body = { type: 'message', message: 'done', xcodingFinalResponse: { permitDigest: 'sha256:test' } };
        const row = { id: 'codex-message-1', seq: 31, localId, createdAt: 54321, content: { t: 'encrypted', c: 'ciphertext' } };
        decryptMock.mockReturnValue({ role: 'agent', content: { type: 'codex', data: body }, meta: { sentFrom: 'cli' } });
        getMock.mockResolvedValue({ data: { messages: [] } });
        writer.emit.mockImplementation((event: string) => {
            if (event === 'message') {
                observer.__listeners.get('update')?.({ body: { t: 'new-message', sid: session.id, message: row } });
            }
        });

        await expect(sendCodexMessageOnce('secret-token', session, {
            messageRole: 'agent', messageType: 'codex', body, localId, timeoutMs: 10_000,
        })).resolves.toEqual({ result: 'success', id: row.id, seq: row.seq, localId, createdAt: row.createdAt });

        expect(ioMock).toHaveBeenCalledTimes(2);
        for (const call of ioMock.mock.calls) {
            expect(call[1]).toEqual(expect.objectContaining({
                auth: { token: 'secret-token', clientType: 'user-scoped' },
                reconnection: false,
                forceNew: true,
            }));
        }
        expect(writer.emit).toHaveBeenCalledWith('message', expect.objectContaining({ sid: session.id, localId }));
        expect(observer.close).toHaveBeenCalledOnce();
        expect(writer.close).toHaveBeenCalledOnce();
    });

    it('HSR confirms a Codex message through query read-back when the observer misses the event', async () => {
        const observer = makeSocket();
        const writer = makeSocket();
        observer.connected = true;
        writer.connected = true;
        ioMock.mockReset().mockReturnValueOnce(observer).mockReturnValueOnce(writer);
        const body = { type: 'message', message: 'done' };
        const row = { id: 'codex-message-2', seq: 32, localId, createdAt: 54322, content: { t: 'encrypted', c: 'ciphertext' } };
        decryptMock.mockReturnValue({ role: 'agent', content: { type: 'codex', data: body }, meta: { sentFrom: 'cli' } });
        getMock
            .mockResolvedValueOnce({ data: { messages: [] } })
            .mockResolvedValueOnce({ data: { messages: [row] } });

        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendCodexMessageOnce({
            messageRole: 'agent', messageType: 'codex', body, localId, timeoutMs: 10_000,
        })).resolves.toEqual({ result: 'success', id: row.id, seq: row.seq, localId, createdAt: row.createdAt });
    });

    it('HSR snapshots the admitted Codex body before asynchronous persistence work', async () => {
        const observer = makeSocket();
        const writer = makeSocket();
        observer.connected = true;
        writer.connected = true;
        ioMock.mockReset().mockReturnValueOnce(observer).mockReturnValueOnce(writer);
        let releasePreflight!: (value: unknown) => void;
        getMock.mockImplementationOnce(() => new Promise((resolve) => { releasePreflight = resolve; }));
        const body = { type: 'message', message: 'original' };
        const row = { id: 'codex-message-snapshot', seq: 34, localId, createdAt: 54324, content: { t: 'encrypted', c: 'ciphertext' } };
        decryptMock.mockReturnValue({
            role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'original' } }, meta: { sentFrom: 'cli' },
        });
        writer.emit.mockImplementation((event: string) => {
            if (event === 'message') observer.__listeners.get('update')?.({ body: { t: 'new-message', sid: session.id, message: row } });
        });

        const pending = sendCodexMessageOnce('secret-token', session, {
            messageRole: 'agent', messageType: 'codex', body, localId, timeoutMs: 10_000,
        });
        body.message = 'mutated-after-admission';
        releasePreflight({ data: { messages: [] } });
        await expect(pending).resolves.toEqual({ result: 'success', id: row.id, seq: row.seq, localId, createdAt: row.createdAt });
    });

    it('HSR rejects a changed Codex payload for an existing localId before allocating a socket', async () => {
        const expectedBody = { type: 'message', message: 'expected' };
        const row = { id: 'codex-message-3', seq: 33, localId, createdAt: 54323, content: { t: 'encrypted', c: 'ciphertext' } };
        decryptMock.mockReturnValue({
            role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'changed' } }, meta: { sentFrom: 'cli' },
        });
        getMock.mockResolvedValue({ data: { messages: [row] } });

        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendCodexMessageOnce({
            messageRole: 'agent', messageType: 'codex', body: expectedBody, localId, timeoutMs: 10_000,
        })).rejects.toThrow(/payload mismatch/);
        expect(ioMock).not.toHaveBeenCalled();
    });

    it('HSR rejects malformed or oversized Codex requests before allocating a socket', async () => {
        const client = new ApiSessionMessageClient('secret-token', session);
        await expect(client.sendCodexMessageOnce({
            messageRole: 'agent', messageType: 'codex', body: {}, localId: 'bad', timeoutMs: 10_000,
        })).rejects.toThrow(/localId/);
        await expect(client.sendCodexMessageOnce({
            messageRole: 'agent', messageType: 'codex', body: { message: 'x'.repeat(70_000) }, localId, timeoutMs: 10_000,
        })).rejects.toThrow(/body size/);
        await expect(client.sendCodexMessageOnce({
            messageRole: 'agent', messageType: 'codex', body: { value: Number.NaN }, localId, timeoutMs: 10_000,
        })).rejects.toThrow(/body value/);
        await expect(client.sendCodexMessageOnce({
            messageRole: 'agent', messageType: 'codex', body: { value: new Date() } as any, localId, timeoutMs: 10_000,
        })).rejects.toThrow(/body object/);
        expect(ioMock).not.toHaveBeenCalled();
    });
});
