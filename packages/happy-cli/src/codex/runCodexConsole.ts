/** Daemon-owned Codex console: account/session menus without a model process. */
import { ApiClient } from '@/api/api';
import { localCommandUserText, type UserMessage } from '@/api/types';
import { registerSessionTransportFatalHandler } from '@/api/registerSessionTransportFatalHandler';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import {
    buildConsoleWelcome, executeBangCommand, hasActiveInteractiveSession,
    handleInteractiveInput, isBangCommand, createConsoleMenu,
} from '@/commands/bang/dispatcher';
import { type BangCommandContext, type BangCommandResult } from '@/commands/bang/types';
import { initialMachineMetadata, shouldRegisterMachineForSession } from '@/daemon/run';
import { readSettings, type Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { completeProviderInputReady } from '@/utils/completeProviderInputReady';
import { createSessionMetadata, HAPPY_CONSOLE_TITLE } from '@/utils/createSessionMetadata';
import { hashObject } from '@/utils/deterministicJson';
import { installHappySessionEnvironment } from '@/utils/projectSessionStartup';
import { activateConsoleMetadata, createSessionTag } from '@/utils/sessionTag';
import { registerShutdownHandlers } from '@/utils/shutdownHandlers';

export async function runCodexConsole(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
    const { machineId } = await readSettings();
    if (!machineId) throw new Error('Codex console requires a registered machine');
    const api = await ApiClient.create(opts.credentials);
    if (shouldRegisterMachineForSession(opts.startedBy)) {
        await api.getOrCreateMachine({ machineId, metadata: initialMachineMetadata });
    }
    const { metadata, state } = createSessionMetadata({
        flavor: 'codex', machineId, startedBy: opts.startedBy, consoleSession: true,
    });
    const response = await api.getOrCreateSession({
        tag: createSessionTag(true, machineId), metadata, state,
    });
    if (!response) throw new Error('Unable to connect the Codex console');
    const session = api.sessionSyncClient(response);
    installHappySessionEnvironment(session.sessionId);
    const ctx: BangCommandContext = {
        client: session, session: null, messageQueue: new MessageQueue2(hashObject),
        currentEnhancedMode: { permissionMode: 'default' },
        // Management commands choose their provider explicitly; transport stays Codex.
        isConsoleSession: true,
    };
    const menu = createConsoleMenu();
    let stop!: () => void;
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    let closing: Promise<void> | undefined;
    const heartbeat = setInterval(() => session.keepAlive(false, 'remote'), 2000);
    const cleanup = (): Promise<void> => {
        if (!closing) {
            closing = (async () => {
                stop();
                clearInterval(heartbeat);
                session.sendSessionDeath();
                try { await session.flush(); } finally { await session.close(); }
            })();
        }
        return closing;
    };
    const removeShutdownHandlers = registerShutdownHandlers(cleanup);
    const removeTransportHandler = registerSessionTransportFatalHandler(session, async () => {
        await cleanup();
        process.exit(1);
    });
    registerKillSessionHandler(session.rpcHandlerManager, async () => {
        await cleanup();
        process.exit(0);
    });
    const sendResult = (result: BangCommandResult): void => {
        for (const message of [result.message].flat()) {
            session.sendSessionEvent({ type: 'message', message });
        }
        session.sendCodexMessage({ type: 'message', message: menu.render(
            result.suggestions?.length ? result.suggestions : ['❇️ @@ 主菜单'],
        ) });
        for (const message of [result.afterSuggestionsMessage ?? []].flat()) {
            session.sendSessionEvent({ type: 'message', message });
        }
        session.sendSessionEvent({ type: 'ready' });
    };
    const onUserMessage = (message: UserMessage): void => {
        if (closing) return;
        const rawText = localCommandUserText(message);
        if (hasActiveInteractiveSession()) {
            handleInteractiveInput(rawText);
            return;
        }
        const text = menu.resolve(rawText);
        menu.clear();
        if (!isBangCommand(text)) {
            sendResult(buildConsoleWelcome());
            return;
        }
        void executeBangCommand(text, ctx).then(result => {
            if (!closing) sendResult(result);
        }).catch(error => {
            logger.debug('[CodexConsole] Command failed:', error);
            if (!closing) sendResult({ message: '❌ 命令执行失败，请重试', action: 'none' });
        });
    };
    try {
        await session.updateMetadata(current => ({
            ...activateConsoleMetadata(current, metadata, Date.now()),
            // Reuse the machine console, including one previously owned by Claude.
            claudeSessionId: undefined,
            summary: { text: HAPPY_CONSOLE_TITLE, updatedAt: Date.now() },
        }), { rejectOnServerError: true });
        await completeProviderInputReady({
            session, expectedHappySessionId: response.id, onUserMessage,
        });
        session.keepAlive(false, 'remote');
        sendResult(buildConsoleWelcome());
        logger.debug(`[CodexConsole] Ready: ${session.sessionId}`);
        await stopped;
    } finally {
        removeShutdownHandlers();
        removeTransportHandler();
        await cleanup();
    }
}
