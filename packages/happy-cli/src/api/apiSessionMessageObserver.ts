import { configuration } from '@/configuration';
import { io, type Socket } from 'socket.io-client';
import { traceHappyServerSocket } from './serverOperationTrace';

/** Creates the supplementary user-scoped receipt observer used by exact Codex persistence. */
export function createUserScopedMessageObserver(
    token: string,
    onUpdate: (data: unknown) => void,
): Socket {
    const socket = io(configuration.serverUrl, {
        auth: { token, clientType: 'user-scoped' as const },
        path: '/v1/updates',
        reconnection: false,
        transports: ['websocket'],
        withCredentials: true,
        autoConnect: false,
        forceNew: true,
    });
    traceHappyServerSocket(socket, 'message-observer');
    socket.on('update', onUpdate);
    return socket;
}
