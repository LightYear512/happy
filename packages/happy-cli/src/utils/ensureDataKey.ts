import { readCredentials, writeCredentialsDataKey } from '@/persistence';
import { configuration } from '@/configuration';
import { randomBytes } from 'node:crypto';
import { open, unlink, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { logger } from '@/ui/logger';

const LOCK_RETRY_INTERVAL_MS = 100;
const MAX_LOCK_ATTEMPTS = 30;       // 3 seconds total
const STALE_LOCK_TIMEOUT_MS = 5000; // Consider lock stale after 5 seconds

/**
 * Ensure access.key contains a dataKey field.
 * Idempotent — uses O_EXCL file lock to prevent multi-process race conditions.
 * Call sites: daemon startup + CLI startup (after authentication).
 */
export async function ensureDataKey(): Promise<void> {
    const cred = await readCredentials();
    if (!cred || cred.encryption.type !== 'dataKey' || cred.encryption.dataKey) {
        return; // No credentials, legacy mode, or already has dataKey
    }

    const lockFile = configuration.privateKeyFile + '.datakey-migration.lock';
    let fileHandle;
    let attempts = 0;

    // Acquire exclusive lock with retries
    while (attempts < MAX_LOCK_ATTEMPTS) {
        try {
            fileHandle = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
            break;
        } catch (err: any) {
            if (err.code === 'EEXIST') {
                attempts++;
                await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
                // Check for stale lock
                try {
                    const stats = await stat(lockFile);
                    if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
                        await unlink(lockFile).catch(() => {});
                    }
                } catch {}
            } else {
                logger.debug(`[ensureDataKey] Failed to acquire lock: ${err.message}`);
                return; // Non-critical migration, skip on unexpected errors
            }
        }
    }

    if (!fileHandle) {
        logger.debug('[ensureDataKey] Could not acquire lock after retries, skipping migration');
        return;
    }

    try {
        // Double-check inside lock — another process may have already migrated
        const fresh = await readCredentials();
        if (fresh && fresh.encryption.type === 'dataKey' && !fresh.encryption.dataKey) {
            await writeCredentialsDataKey({
                publicKey: fresh.encryption.publicKey,
                machineKey: fresh.encryption.machineKey,
                dataKey: new Uint8Array(randomBytes(32)),
                token: fresh.token
            });
            logger.debug('[ensureDataKey] Migrated access.key with new dataKey');
        }
    } catch (err: any) {
        logger.debug(`[ensureDataKey] Migration failed: ${err.message}`);
    } finally {
        await fileHandle.close();
        await unlink(lockFile).catch(() => {});
    }
}
