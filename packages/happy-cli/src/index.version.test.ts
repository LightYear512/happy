import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('CLI version command', () => {
  it('prints the Happy version and exits before session or daemon startup', async () => {
    const result = await execFileAsync('npx', ['--no-install', 'tsx', 'src/index.ts', '--version'], {
      cwd: process.cwd(),
      env: { ...process.env, HAPPY_VARIANT: 'stable' },
      timeout: 5_000,
    });

    expect(result.stdout.split('\n').filter(line => line.startsWith('happy version: ')))
      .toEqual([expect.stringMatching(/^happy version: \S+$/u)]);
    expect(result.stdout).not.toContain('Account:');
  });
});
