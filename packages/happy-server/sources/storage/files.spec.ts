import { afterEach, describe, expect, it, vi } from 'vitest';

describe('S3 file storage module', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('loads the MinIO client when S3 storage is configured', async () => {
        vi.stubEnv('S3_HOST', 'localhost');
        vi.stubEnv('S3_PORT', '9000');
        vi.stubEnv('S3_USE_SSL', 'false');
        vi.stubEnv('S3_ACCESS_KEY', 'test-access-key');
        vi.stubEnv('S3_SECRET_KEY', 'test-secret-key');
        vi.stubEnv('S3_BUCKET', 'test-bucket');
        vi.stubEnv('S3_PUBLIC_URL', 'http://localhost:9000/test-bucket');

        const files = await import('./files');

        expect(files.isLocalStorage()).toBe(false);
        expect(files.s3client).toBeTruthy();
        expect(files.s3bucket).toBe('test-bucket');
        expect(files.s3host).toBe('localhost');
    });
});
