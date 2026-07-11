import { configuration } from '@/configuration';
import { io, type Socket } from 'socket.io-client';
import { encodeBase64, encrypt } from './encryption';
import type { Metadata, Session } from './types';

type MetadataUpdateAnswer =
    | { result: 'success'; version: number; metadata: string }
    | { result: 'version-mismatch'; version: number; metadata: string }
    | { result: 'error' };

/** One-shot metadata writer. It deliberately does not own session lifecycle. */
export class ApiSessionMetadataClient {
    private readonly socket: Socket;
    private readonly sessionId: string;
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: 'legacy' | 'dataKey';
    private metadata: Metadata;
    private metadataVersion: number;

    constructor(token: string, session: Session) {
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;
        this.socket = io(configuration.serverUrl, {
            auth: { token, clientType: 'user-scoped' as const },
            path: '/v1/updates',
            reconnection: false,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false
        });
    }

    waitForConnect(timeoutMs: number): Promise<void> {
        if (this.socket.connected) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                this.socket.off('connect', onConnect);
                this.socket.off('connect_error', onError);
            };
            const onConnect = () => {
                cleanup();
                resolve();
            };
            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('Socket connect timeout'));
            }, timeoutMs);
            this.socket.once('connect', onConnect);
            this.socket.once('connect_error', onError);
            this.socket.connect();
        });
    }

    async updateSummaryOnce(summary: string, timeoutMs: number): Promise<{ version: number }> {
        const updated: Metadata = {
            ...this.metadata,
            summary: { text: summary, updatedAt: Date.now() }
        };
        const answer = await this.socket.timeout(timeoutMs).emitWithAck('update-metadata', {
            sid: this.sessionId,
            expectedVersion: this.metadataVersion,
            metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)),
            claudeSessionId: updated.claudeSessionId,
            summary,
            machineId: updated.machineId
        }) as MetadataUpdateAnswer;
        if (answer.result === 'success') {
            this.metadata = updated;
            this.metadataVersion = answer.version;
            return { version: answer.version };
        }
        if (answer.result === 'version-mismatch') {
            throw new Error('Metadata version mismatch');
        }
        throw new Error('Metadata update failed');
    }

    close(): void {
        this.socket.close();
    }
}
