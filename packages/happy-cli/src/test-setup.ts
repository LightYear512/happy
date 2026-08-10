/**
 * Test setup file for vitest
 *
 * Global setup that runs ONCE before all tests
 */

import { spawnSync } from 'node:child_process'

export function setup() {
  // Extend test timeout for integration tests
  process.env.VITEST_POOL_TIMEOUT = '60000'

  if (process.env.HAPPY_SKIP_TEST_BUILD === '1') return

  // Make sure to build the project before running tests
  // We rely on the dist files to spawn our CLI in integration tests
  const buildResult = spawnSync('yarn', ['build'], { stdio: 'pipe' })

  if (buildResult.error || buildResult.status !== 0) {
    const stdout = buildResult.stdout?.toString() ?? ''
    const stderr = buildResult.stderr?.toString() ?? ''
    throw new Error(`Build failed with status ${buildResult.status ?? 'spawn-error'}:\n${stdout}\n${stderr}`)
  }
}
