import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    NETWORK_ERROR_CODES,
    connectionState,
    isNetworkError,
    printOfflineWarning,
} from './serverConnectionErrors';

describe('serverConnectionErrors', () => {
    beforeEach(() => {
        connectionState.reset();
        vi.restoreAllMocks();
    });

    it('prints one local-only warning and does not promise automatic reconnection', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        printOfflineWarning();
        printOfflineWarning();

        expect(consoleSpy).toHaveBeenCalledTimes(1);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(
            'running locally without automatic session-create retry',
        ));
    });

    it('prints accumulated detail lines without changing request flow', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        connectionState.fail({
            operation: 'Session creation',
            errorCode: '503',
            url: 'https://happy.test/v1/sessions',
            details: ['No automatic retry'],
        });

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Session creation failed'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No automatic retry'));
    });

    it('recognizes only the admitted network error codes', () => {
        for (const code of NETWORK_ERROR_CODES) expect(isNetworkError(code)).toBe(true);
        for (const code of ['UNAUTHORIZED', 'EACCES', 'ENOENT', 'UNKNOWN', '', undefined]) {
            expect(isNetworkError(code)).toBe(false);
        }
        expect(NETWORK_ERROR_CODES).toHaveLength(6);
    });
});
