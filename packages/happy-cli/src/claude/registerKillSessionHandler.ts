import { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import { logger } from "@/lib";

interface KillSessionRequest {
    // No parameters needed
}

interface KillSessionResponse {
    success: boolean;
    message: string;
}

// Socket.IO must have a chance to serialize and flush the RPC acknowledgement
// before killThisHappy can close the session socket or call process.exit().
// The daemon machine RPC uses the same bounded acknowledgement grace period.
const KILL_RPC_ACK_GRACE_MS = 100;


export function registerKillSessionHandler(
    rpcHandlerManager: RpcHandlerManager,
    killThisHappy: () => Promise<void>
) {
    rpcHandlerManager.registerHandler<KillSessionRequest, KillSessionResponse>('killSession', async () => {
        logger.debug('Kill session request received');

        // Starting cleanup here races RpcHandlerManager's encrypted response
        // path: an idle runtime can reach process.exit() before Socket.IO sends
        // its ACK. Defer cleanup until after that ACK returns to the event loop.
        setTimeout(() => {
            void killThisHappy().catch((error) => {
                logger.debug('Kill session cleanup failed', error);
            });
        }, KILL_RPC_ACK_GRACE_MS);

        return {
            success: true,
            message: 'Killing happy-cli process'
        };
    });
}
