import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, logger, pruneLogDirectory } from './logger';

const originalDebug = process.env.DEBUG;
const originalRemoteLogging = process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING;

beforeEach(() => {
  delete process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING;
});

afterEach(() => {
  if (originalDebug === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = originalDebug;
  if (originalRemoteLogging === undefined) delete process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING;
  else process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = originalRemoteLogging;
  vi.restoreAllMocks();
});

describe('large JSON logging', () => {
  it('does no synchronous file I/O for ordinary production debug logs', () => {
    delete process.env.DEBUG;
    const write = vi.spyOn(logger as unknown as { logToFile: (...args: unknown[]) => void }, 'logToFile');

    logger.debug('ordinary production input');

    expect(write).not.toHaveBeenCalled();
  });

  it('does no remote I/O outside DEBUG even when the dangerous switch is set', async () => {
    delete process.env.DEBUG;
    process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = '1';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const quiet = new Logger();

    quiet.debug('ordinary production input');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains local file logging when DEBUG is explicit', () => {
    process.env.DEBUG = '1';
    const write = vi.spyOn(logger as unknown as { logToFile: (...args: unknown[]) => void }, 'logToFile')
      .mockImplementation(() => {});

    logger.debug('explicit debug input');

    expect(write).toHaveBeenCalledOnce();
  });

  it('does no formatting or file I/O outside DEBUG mode', () => {
    delete process.env.DEBUG;
    const write = vi.spyOn(logger as unknown as { logToFile: (...args: unknown[]) => void }, 'logToFile');
    const value = new Proxy({}, {
      ownKeys: () => { throw new Error('large object was traversed'); },
    });

    expect(() => logger.debugLargeJson('ignored', value)).not.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it('writes asynchronously within the per-file capacity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happy-logger-'));
    const file = join(directory, 'bounded.log');
    process.env.DEBUG = '1';
    try {
      const bounded = new Logger(file, 256);
      for (let index = 0; index < 20; index += 1) bounded.debug('x'.repeat(100));
      await bounded.flush();
      expect((await stat(file)).size).toBeLessThanOrEqual(256);
      expect((await readFile(file, 'utf8')).length).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('writes bounded lifecycle traces in production without formatting message bodies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happy-trace-'));
    const file = join(directory, 'trace.log');
    delete process.env.DEBUG;
    try {
      const bounded = new Logger(file, 256);
      bounded.trace('[INPUT] persisted row received', 'session-1', 'message-1', 7);
      await bounded.flush();
      await expect(readFile(file, 'utf8')).resolves.toMatch(/session-1 message-1 7/u);
      expect((await stat(file)).size).toBeLessThanOrEqual(256);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('prunes expired logs and enforces the directory capacity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happy-log-prune-'));
    const current = join(directory, 'current.log');
    const expired = join(directory, 'expired.log');
    const older = join(directory, 'older.log');
    try {
      await Promise.all([
        writeFile(current, 'c'.repeat(64)),
        writeFile(expired, 'e'.repeat(64)),
        writeFile(older, 'o'.repeat(64)),
      ]);
      const now = Date.now();
      await utimes(expired, new Date(now - 10_000), new Date(now - 10_000));
      await utimes(older, new Date(now - 1_000), new Date(now - 1_000));
      await pruneLogDirectory(directory, current, { now, maxAgeMs: 5_000, maxBytes: 64 });
      await expect(stat(expired)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(older)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(current)).size).toBe(64);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bounds the number of retained log files even when they are small', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happy-log-count-'));
    const current = join(directory, 'current.log');
    try {
      await Promise.all([
        writeFile(current, 'current'),
        writeFile(join(directory, 'first.log'), '1'),
        writeFile(join(directory, 'second.log'), '2'),
      ]);
      await pruneLogDirectory(directory, current, {
        maxAgeMs: Number.MAX_SAFE_INTEGER,
        maxBytes: Number.MAX_SAFE_INTEGER,
        maxFiles: 1,
      });
      await expect(readdir(directory)).resolves.toEqual(['current.log']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
