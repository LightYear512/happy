const { execSync } = require('child_process');
const path = require('path');

// Apply patches to node_modules
require('../patches/fix-pglite-prisma-bytes.cjs');

// Apply patch-package patches from root /patches.
// On EAS Build yarn workspaces are NOT enabled (yarn warns "Workspaces can
// only be enabled in private projects" — EAS flattens everything), so all
// node_modules live at root, and a single root patch-package invocation
// covers every patched package.
const patchPkg = path.resolve(__dirname, '../node_modules/.bin/patch-package');
const repoRoot = path.resolve(__dirname, '..');

try {
  execSync(`"${patchPkg}"`, { cwd: repoRoot, stdio: 'inherit' });
} catch (e) {
  console.warn('[postinstall] patch-package reported issues:', e.message);
}

if (process.env.SKIP_HAPPY_WIRE_BUILD === '1') {
  console.log('[postinstall] SKIP_HAPPY_WIRE_BUILD=1, skipping @slopus/happy-wire build');
  process.exit(0);
}

execSync('yarn workspace @slopus/happy-wire build', {
  stdio: 'inherit',
});
