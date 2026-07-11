/**
 * Library exports for slopus package
 * 
 * This file provides the main API classes and types for external consumption
 * without the CLI-specific functionality.
 */

// These exports allow me to use this package a library in dev-environment cli helper programs
export { ApiClient } from '@/api/api'
export { ApiSessionClient } from '@/api/apiSession'
export {
  ApiSessionMessageClient,
  sendCodexMessageOnce,
  sendUserMessageOnce,
  validateCodexMessageOnceRequest,
  validateUserMessageOnceRequest
} from '@/api/apiSessionMessage'
export type {
  CodexMessageOnceRequest,
  PersistedMessageReceipt,
  UserMessageOnceRequest
} from '@/api/apiSessionMessage'
export { readCredentials } from '@/persistence'

export { logger } from '@/ui/logger'
export { configuration } from '@/configuration'

export { RawJSONLinesSchema, type RawJSONLines } from '@/claude/types'
export { encodeBase64, decodeBase64, encrypt, decrypt } from '@/api/encryption'
