/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import type { Metadata, PermissionMode } from '@/api/types';
import { XC_VIRTUAL_SESSION_ID_PATTERN, type ObservedTrackedSession } from './types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

export function startDaemonControlServer({
  getChildren,
  stopSession,
  restoreSession,
  replaceSession,
  spawnSession,
  prepareShutdown,
  requestShutdown,
  onHappySessionWebhook,
  onCodexProfile,
}: {
  getChildren: () => ObservedTrackedSession[] | Promise<ObservedTrackedSession[]>;
  stopSession: (sessionId: string) => Promise<boolean>;
  restoreSession: (sessionId: string, permissionMode?: PermissionMode) =>
    Promise<SpawnSessionResult & { agent?: 'claude' | 'codex' | 'gemini' }>;
  replaceSession?: (input: { previousSessionId: string; providerSessionId: string;
    virtualSessionId: string; title: string }) => Promise<SpawnSessionResult & { agent?: 'claude' | 'codex' | 'gemini' }>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  prepareShutdown: (options: { stopSessions: boolean }) =>
    Promise<{ accepted: true } | { accepted: false; error: string }>;
  requestShutdown: () => void;
  onHappySessionWebhook: (
    sessionId: string,
    metadata: Metadata,
    readyProviderSessionId?: string,
  ) => void | Promise<void>;
  onCodexProfile?: (sessionId: string, profileName: string) => Promise<boolean>;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = fastify({
      logger: false // We use our own logger
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Session reports itself after creation
    typed.post('/session-started', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          metadata: z.any(), // Metadata type from API
          readyProviderSessionId: z.string().uuid().optional(),
          transportHealth: z.unknown().nullable().optional(),
        }).strict(),
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      const { sessionId, metadata, readyProviderSessionId } = request.body;

      logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);
      await onHappySessionWebhook(sessionId, metadata, readyProviderSessionId);

      return { status: 'ok' as const };
    });

    typed.post('/session-codex-profile', {
      schema: {
        body: z.object({
          sessionId: z.string().min(1).max(128),
          profileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
        }).strict(),
        response: {
          200: z.object({ success: z.literal(true) }),
          409: z.object({ success: z.literal(false), error: z.string() }),
        },
      },
    }, async (request, reply) => {
      if (onCodexProfile && await onCodexProfile(request.body.sessionId, request.body.profileName)) {
        return { success: true as const };
      }
      reply.code(409);
      return { success: false as const, error: 'Codex profile restore authority was not updated' };
    });

    // List all tracked sessions
    typed.post('/list', {
      schema: {
        response: {
          200: z.object({
            children: z.array(z.object({
              startedBy: z.string(),
              happySessionId: z.string(),
              pid: z.number()
            })),
            presenceVersion: z.literal(1),
            unknownSessionIds: z.array(z.string()),
          })
        }
      }
    }, async () => {
      const children = await getChildren();
      const visible = children.filter(child => child.happySessionId !== undefined
        && child.isConsoleSession !== true && child.inputState !== 'offline');
      const unknownSessionIds = visible.filter(child => child.inputState === 'unknown')
        .map(child => child.happySessionId!);
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return {
        children: visible
          .map(child => ({
            startedBy: child.startedBy,
            happySessionId: child.happySessionId!,
            pid: child.pid
          })),
        presenceVersion: 1 as const,
        unknownSessionIds,
      };
    });

    // Stop specific session
    typed.post('/stop-session', {
      schema: {
        body: z.object({
          sessionId: z.string()
        }),
        response: {
          200: z.object({
            success: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { sessionId } = request.body;

      logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
      const success = await stopSession(sessionId);
      return { success };
    });

    typed.post('/restore-session', {
      schema: {
        body: z.object({
          sessionId: z.string().min(1).max(128),
          permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan',
            'read-only', 'safe-yolo', 'yolo']).optional(),
        }).strict(),
        response: {
          200: z.object({
            success: z.literal(true),
            sessionId: z.string(),
            agent: z.enum(['claude', 'codex', 'gemini']),
          }),
          500: z.object({ success: z.literal(false), error: z.string() }),
        },
      },
    }, async (request, reply) => {
      const result = await restoreSession(request.body.sessionId, request.body.permissionMode);
      if (result.type === 'success' && result.sessionId === request.body.sessionId && result.agent) {
        return { success: true as const, sessionId: result.sessionId, agent: result.agent };
      }
      reply.code(500);
      return { success: false as const, error: result.type === 'error'
        ? result.errorMessage : 'Happy did not restore the exact requested session' };
    });

    typed.post('/replace-session', {
      schema: {
        body: z.object({
          previousSessionId: z.string().min(1).max(128),
          providerSessionId: z.string().uuid(),
          virtualSessionId: z.string().regex(XC_VIRTUAL_SESSION_ID_PATTERN),
          title: z.string().min(1).max(240),
        }).strict(),
        response: {
          200: z.object({ success: z.literal(true), sessionId: z.string(),
            agent: z.enum(['claude', 'codex', 'gemini']) }),
          500: z.object({ success: z.literal(false), error: z.string() }),
        },
      },
    }, async (request, reply) => {
      const result = replaceSession
        ? await replaceSession(request.body)
        : { type: 'error' as const, errorMessage: 'Closed-session replacement is unavailable' };
      if (result.type === 'success' && result.sessionId && result.agent) {
        return { success: true as const, sessionId: result.sessionId, agent: result.agent };
      }
      reply.code(500);
      return { success: false as const, error: result.type === 'error'
        ? result.errorMessage : 'Happy did not replace the closed session' };
    });

    // Spawn new session
    typed.post('/spawn-session', {
      schema: {
        body: z.object({
          directory: z.string(),
          sessionId: z.string().optional(),
          resume: z.string().optional(),
          title: z.string().optional(),
          titleAuthority: z.literal('external').optional(),
          agent: z.enum(['claude', 'codex', 'gemini']).optional(),
          permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan',
            'read-only', 'safe-yolo', 'yolo']).optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            approvedNewDirectoryCreation: z.boolean().optional()
          }),
          409: z.object({
            success: z.boolean(),
            requiresUserApproval: z.boolean().optional(),
            actionRequired: z.string().optional(),
            directory: z.string().optional()
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional()
          })
        }
      }
    }, async (request, reply) => {
      const { directory, sessionId, resume, title, titleAuthority, agent, permissionMode } = request.body;

      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}, resume=${resume || 'none'}, agent=${agent || 'default'}`);
      const result = await spawnSession({
        directory,
        restoreSessionId: sessionId,
        resume,
        title,
        titleAuthority,
        agent,
        permissionMode,
      });

      switch (result.type) {
        case 'success':
          // Check if sessionId exists, if not return error
          if (!result.sessionId) {
            reply.code(500);
            return {
              success: false,
              error: 'Failed to spawn session: no session ID returned'
            };
          }
          return {
            success: true,
            sessionId: result.sessionId,
            approvedNewDirectoryCreation: true
          };
        
        case 'requestToApproveDirectoryCreation':
          reply.code(409); // Conflict - user input needed
          return { 
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: result.directory
          };
        
        case 'superseded':
          // Session was killed because a newer resume for the same Claude session
          // was requested. Return 200 so the caller doesn't show an error.
          return {
            success: true,
            approvedNewDirectoryCreation: true
          };

        case 'error':
          reply.code(500);
          return {
            success: false,
            error: result.errorMessage
          };
      }
    });

    // Stop daemon
    typed.post('/stop', {
      schema: {
        body: z.object({
          stopSessions: z.boolean().optional(),
        }).nullish(),
        response: {
          200: z.object({
            status: z.enum(['stopping', 'blocked']),
            error: z.string().optional(),
          })
        }
      }
    }, async (request) => {
      const stopSessions = request.body?.stopSessions === true;
      logger.debug('[CONTROL SERVER] Stop daemon request received', { stopSessions });

      const prepared = await prepareShutdown({ stopSessions });
      if (!prepared.accepted) {
        logger.debug('[CONTROL SERVER] Daemon shutdown blocked', { stopSessions, error: prepared.error });
        return { status: 'blocked' as const, error: prepared.error };
      }

      // Give time for response to arrive
      setTimeout(() => {
        logger.debug('[CONTROL SERVER] Triggering daemon shutdown', { stopSessions });
        requestShutdown();
      }, 50);

      return { status: 'stopping' as const };
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
