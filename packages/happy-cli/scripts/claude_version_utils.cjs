/**
 * Shared utilities for finding and resolving Claude Code CLI path
 * Used by both local and remote launchers
 *
 * Supports multiple installation methods:
 * 1. npm global: npm install -g @anthropic-ai/claude-code
 * 2. Homebrew: brew install claude-code
 * 3. Native installer:
 *    - macOS/Linux: curl -fsSL https://claude.ai/install.sh | bash
 *    - PowerShell:  irm https://claude.ai/install.ps1 | iex
 *    - Windows CMD: curl -fsSL https://claude.ai/install.cmd | cmd
 * 4. PATH fallback: bun, pnpm, or any other package manager
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Safely resolve symlink or return path if it exists
 * @param {string} filePath - Path to resolve
 * @returns {string|null} Resolved path or null if not found
 */
function resolvePathSafe(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return fs.realpathSync(filePath);
    } catch (e) {
        return filePath;
    }
}

/**
 * Resolve the executable entry inside a claude-code package directory.
 * Supports both the legacy single-file layout (cli.js) and the 2.1.100+ wrapper
 * layout (cli-wrapper.cjs + bin/claude[.exe] native binary).
 *
 * Priority: cli.js > cli-wrapper.cjs > bin/claude[.exe].
 *
 * Interceptor note: only legacy cli.js actually keeps the launcher's fetch
 * interceptor useful — cli.js *is* the Claude CLI code, so its fetch() calls
 * run in-process and are visible to the launcher's global.fetch override.
 * cli-wrapper.cjs and bin/claude[.exe] both spawn the native binary as a
 * child process; the real API calls happen there and cannot be intercepted
 * from the parent. cli-wrapper.cjs is still preferred over the bare binary
 * because it works under `npm install --ignore-scripts`, where postinstall
 * hasn't copied the native binary into bin/.
 *
 * @param {string} pkgDir - Path to @anthropic-ai/claude-code package root
 * @returns {string|null} Path to entry (cli.js / cli-wrapper.cjs / binary) or null
 */
function resolveClaudeEntryInPkg(pkgDir) {
    if (!pkgDir) return null;
    const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const candidates = [
        path.join(pkgDir, 'cli.js'),
        path.join(pkgDir, 'cli-wrapper.cjs'),
        path.join(pkgDir, 'bin', binName),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

// Walk up from a resolved shim path to find the enclosing claude-code package.
// bin/claude[.exe] lives 2 dirs below pkg root; cli.js/cli-wrapper.cjs lives 1.
// Add a margin for future layout drift.
const PKG_WALKUP_DEPTH = 3;

/**
 * Walk parent directories from `startDir` up to PKG_WALKUP_DEPTH levels and
 * return the first directory that resolves to a claude-code entry. Single
 * source of truth for the walk-up pattern used by findClaudeInPath,
 * findClaudeInBunHome, and any future caller that has a shim path and wants
 * its enclosing package's preferred entry.
 *
 * Stops on filesystem root (path.dirname fixed-point) regardless of depth.
 *
 * @param {string} startDir - Directory to start walk-up from (typically dirname of resolved shim)
 * @param {number} [depth=PKG_WALKUP_DEPTH] - Maximum levels to walk
 * @returns {string|null} Path to entry or null if no enclosing pkg found
 */
function walkUpToPkgEntry(startDir, depth = PKG_WALKUP_DEPTH) {
    let dir = startDir;
    for (let i = 0; i < depth && dir; i++) {
        const entry = resolveClaudeEntryInPkg(dir);
        if (entry) return entry;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Find path to npm globally installed Claude Code CLI
 * @returns {string|null} Path to cli.js or null if not found
 */
function findNpmGlobalCliPath() {
    try {
        const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
        const pkgDir = path.join(globalRoot, '@anthropic-ai', 'claude-code');
        return resolveClaudeEntryInPkg(pkgDir);
    } catch (e) {}
    return null;
}

/**
 * Find Claude CLI using system PATH (which/where command)
 * Respects user's configuration and works across all platforms
 * @returns {{path: string, source: string}|null} Path and source, or null if not found
 */
function findClaudeInPath() {
    try {
        const command = process.platform === 'win32' ? 'where claude' : 'which claude';
        const result = execSync(command, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();

        const claudePath = result.split('\n')[0].trim(); // Take first match
        if (!claudePath) return null;

        // Check existence BEFORE resolving (from tiann/PR#83)
        if (!fs.existsSync(claudePath)) return null;

        // Resolve with fallback to original path (from tiann/PR#83)
        const resolvedPath = resolvePathSafe(claudePath) || claudePath;

        if (resolvedPath) {
            // On Windows, npm creates shell script shims (no extension) for global packages.
            // These cannot be spawned directly by Node.js. When we find such a shim,
            // resolve to the actual entry inside the adjacent node_modules directory.
            const isExecutable = resolvedPath.endsWith('.js') || resolvedPath.endsWith('.cjs') || resolvedPath.endsWith('.exe');
            if (!isExecutable) {
                // NVM on Windows uses a junction at C:\Program Files\nodejs → nvm\vX.Y.Z,
                // so the junction path and the realpath dir can host different node_modules
                // trees. Probe both, dedup when realpath is a no-op.
                const shimDir = path.dirname(claudePath);
                const realDir = path.dirname(resolvedPath);
                const searchDirs = shimDir === realDir ? [shimDir] : [shimDir, realDir];
                for (const baseDir of searchDirs) {
                    const pkgDir = path.join(baseDir, 'node_modules', '@anthropic-ai', 'claude-code');
                    const entry = resolveClaudeEntryInPkg(pkgDir);
                    if (entry) {
                        return { path: entry, source: 'npm' };
                    }
                }
                return null;
            }

            // Walk up to claude-code pkg root and re-run priority resolver, so PATH
            // detection picks the same entry as the other finders even when the
            // shim points directly at wrapper/binary while a higher-priority cli.js
            // exists in the same package (upgrade/downgrade window, yalc link, etc.).
            const preferredPath = walkUpToPkgEntry(path.dirname(resolvedPath)) || resolvedPath;

            // Detect source from BOTH original PATH entry and final preferred path.
            // Original path tells us HOW user accessed it (context); preferred path
            // tells us WHERE the chosen entry actually lives (content).
            const originalSource = detectSourceFromPath(claudePath);
            const resolvedSource = detectSourceFromPath(preferredPath);
            const source = originalSource !== 'PATH' ? originalSource : resolvedSource;

            return {
                path: preferredPath,
                source: source
            };
        }
    } catch (e) {}
    return null;
}

/**
 * Detect installation source from resolved path
 * Uses concrete path patterns, no assumptions
 * @param {string} resolvedPath - The resolved path to cli.js
 * @returns {string} Installation method/source
 */
function detectSourceFromPath(resolvedPath) {
    // Normalize separators to forward slashes so that pattern matching with
    // includes('opt/homebrew') etc. works identically on Windows and Unix.
    const normalizedPath = path.normalize(resolvedPath).replace(/\\/g, '/').toLowerCase();

    // Bun: ~/.bun/bin/claude -> ../node_modules/@anthropic-ai/claude-code/cli.js
    // Works on Windows too: C:\Users\[user]\.bun\bin\claude
    if (normalizedPath.includes('.bun') && normalizedPath.includes('bin') ||
        (normalizedPath.includes('node_modules') && normalizedPath.includes('.bun'))) {
        return 'Bun';
    }

    // Homebrew cask: hashed directories like .claude-code-2DTsDk1V (NOT npm installations)
    // Must check before general Homebrew paths to distinguish from npm-through-Homebrew
    if (normalizedPath.includes('@anthropic-ai') && normalizedPath.includes('.claude-code-')) {
        return 'Homebrew';
    }

    // npm: clean claude-code directory (even through Homebrew's npm)
    // Windows: %APPDATA%\npm\node_modules\@anthropic-ai\claude-code
    if (normalizedPath.includes('node_modules') && normalizedPath.includes('@anthropic-ai') && normalizedPath.includes('claude-code') &&
        !normalizedPath.includes('.claude-code-')) {
        return 'npm';
    }

    // Windows-specific detection (detect by path patterns, not current platform)
    if (normalizedPath.includes('appdata') || normalizedPath.includes('program files') || normalizedPath.endsWith('.exe')) {
        // Windows npm
        if (normalizedPath.includes('appdata') && normalizedPath.includes('npm') && normalizedPath.includes('node_modules')) {
            return 'npm';
        }

        // Windows native installer (any location ending with claude.exe)
        if (normalizedPath.endsWith('claude.exe')) {
            return 'native installer';
        }

        // Windows native installer in AppData
        if (normalizedPath.includes('appdata') && normalizedPath.includes('claude')) {
            return 'native installer';
        }

        // Windows native installer in Program Files
        if (normalizedPath.includes('program files') && normalizedPath.includes('claude')) {
            return 'native installer';
        }
    }

    // Homebrew general paths (for non-npm installations like Cellar binaries)
    // Apple Silicon: /opt/homebrew/bin/claude
    // Intel Mac: /usr/local/bin/claude (ONLY on macOS, not Linux)
    // Linux Homebrew: /home/linuxbrew/.linuxbrew/bin/claude or ~/.linuxbrew/bin/claude
    if (normalizedPath.includes('opt/homebrew') ||
        normalizedPath.includes('usr/local/homebrew') ||
        normalizedPath.includes('home/linuxbrew') ||
        normalizedPath.includes('.linuxbrew') ||
        normalizedPath.includes('.homebrew') ||
        normalizedPath.includes('cellar') ||
        normalizedPath.includes('caskroom') ||
        (normalizedPath.includes('usr/local/bin/claude') && process.platform === 'darwin')) { // Intel Mac Homebrew default only on macOS
        return 'Homebrew';
    }

    // Native installer: standard Unix locations and ~/.local/bin
    // /usr/local/bin/claude on Linux should be native installer
    if (normalizedPath.includes('.local') && normalizedPath.includes('bin') ||
        normalizedPath.includes('.local') && normalizedPath.includes('share') && normalizedPath.includes('claude') ||
        (normalizedPath.includes('usr/local/bin/claude') && process.platform === 'linux')) { // Linux native installer
        return 'native installer';
    }

    // Default: we found it in PATH but can't determine source
    return 'PATH';
}

/**
 * Find path to Bun globally installed Claude Code CLI
 * FIX: Check bun's bin directory, not non-existent modules directory
 * @returns {string|null} Path to cli.js or null if not found
 */
/**
 * Locate the Claude entry under a given Bun home directory.
 * Extracted from findBunGlobalCliPath so tests can inject a fake homedir
 * built with mkdtemp instead of mocking os.homedir() globally.
 *
 * @param {string} homedir - Directory that holds .bun/bin/claude
 * @returns {string|null} Path to entry or null
 */
function findClaudeInBunHome(homedir) {
    const bunBin = path.join(homedir, '.bun', 'bin', 'claude');
    const resolved = resolvePathSafe(bunBin);
    if (!resolved) return null;

    // Legacy layout: bun symlinked directly to cli.js
    if (resolved.endsWith('cli.js')) {
        return resolved;
    }

    // New layout (2.1.100+): bun's shim points at the package's bin/claude[.exe] or
    // cli-wrapper.cjs. Walk up to the package root and use the shared resolver.
    return walkUpToPkgEntry(path.dirname(resolved));
}

function findBunGlobalCliPath() {
    // First check if bun command exists (cross-platform)
    try {
        const bunCheckCommand = process.platform === 'win32' ? 'where bun' : 'which bun';
        execSync(bunCheckCommand, { encoding: 'utf8' });
    } catch (e) {
        return null; // bun not installed
    }

    return findClaudeInBunHome(os.homedir());
}

/**
 * Locate the Claude entry inside one Homebrew prefix.
 * Extracted from findHomebrewCliPath so tests can construct fake prefixes
 * with mkdtemp without mocking platform-wide symlink resolution.
 *
 * Probes both Layout A (npm-via-brew, symlink → node_modules tree) and
 * Layout B (Cellar cask, symlink → standalone binary).
 *
 * @param {string} prefix - Homebrew prefix dir (e.g. /opt/homebrew)
 * @returns {string|null} Path to entry or null
 */
function findClaudeInHomebrewPrefix(prefix) {
    // --- Layout A or B: follow the <prefix>/bin/claude symlink ---
    const binPath = path.join(prefix, 'bin', 'claude');
    const resolved = resolvePathSafe(binPath);
    if (resolved && fs.existsSync(resolved)) {
        const inBinDir = path.basename(path.dirname(resolved)) === 'bin';
        const pkgRoot = inBinDir ? path.dirname(path.dirname(resolved)) : path.dirname(resolved);
        const entry = resolveClaudeEntryInPkg(pkgRoot);
        if (entry) return entry;          // Layout A
        return resolved;                   // Layout B (standalone binary)
    }

    // --- Layout A fallback: no top-level symlink but pkg still installed ---
    // Homebrew cask sometimes stores claude-code under hashed dirs like
    // `.claude-code-<hash>/` alongside the canonical `claude-code/`.
    const nodeModulesPath = path.join(prefix, 'lib', 'node_modules', '@anthropic-ai');
    if (fs.existsSync(nodeModulesPath)) {
        const entries = fs.readdirSync(nodeModulesPath);
        for (const entry of entries) {
            if (entry === 'claude-code' || entry.startsWith('.claude-code-')) {
                const found = resolveClaudeEntryInPkg(path.join(nodeModulesPath, entry));
                if (found) return found;
            }
        }
    }

    return null;
}

/**
 * Find path to Homebrew installed Claude Code CLI
 * FIX: Handle hashed directory names like .claude-code-[hash]
 * @returns {string|null} Path to cli.js or binary, or null if not found
 */
function findHomebrewCliPath() {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
        return null;
    }

    const possiblePrefixes = [
        '/opt/homebrew',
        '/usr/local',
        path.join(os.homedir(), '.linuxbrew'),
        path.join(os.homedir(), '.homebrew')
    ].filter(fs.existsSync);

    // Homebrew hosts claude-code through two distinct layouts; probe both per prefix:
    //   A) npm-via-brew (`brew install claude-code`): symlink in <prefix>/bin points
    //      into a standard <prefix>/lib/node_modules/@anthropic-ai/claude-code/... tree.
    //      Walk the symlink target back to its pkg root and delegate to the shared
    //      resolver so we pick the highest-priority entry (cli.js > wrapper > binary).
    //   B) Cellar cask (self-contained binary): symlink points at a standalone binary
    //      under <prefix>/Cellar/<pkg>/<ver>/bin/claude with no npm layout. Return it
    //      verbatim for spawn.
    for (const prefix of possiblePrefixes) {
        const found = findClaudeInHomebrewPrefix(prefix);
        if (found) return found;
    }

    return null;
}

/**
 * Find path to native installer Claude Code CLI
 * 
 * Installation locations:
 * - macOS/Linux: ~/.local/bin/claude (symlink) -> ~/.local/share/claude/versions/<version>
 * - Windows: %LOCALAPPDATA%\Claude\ or %USERPROFILE%\.claude\
 * - Legacy: ~/.claude/local/
 * 
 * @returns {string|null} Path to cli.js or binary, or null if not found
 */
function findNativeInstallerCliPath() {
    const homeDir = os.homedir();
    
    // Windows-specific locations
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
        
        // Check %LOCALAPPDATA%\Claude\
        const windowsClaudePath = path.join(localAppData, 'Claude');
        if (fs.existsSync(windowsClaudePath)) {
            // Check for versions directory
            const versionsDir = path.join(windowsClaudePath, 'versions');
            if (fs.existsSync(versionsDir)) {
                const found = findLatestVersionBinary(versionsDir);
                if (found) return found;
            }
            
            // Check for claude.exe directly
            const exePath = path.join(windowsClaudePath, 'claude.exe');
            if (fs.existsSync(exePath)) {
                return exePath;
            }
            
            // Check for cli.js
            const cliPath = path.join(windowsClaudePath, 'cli.js');
            if (fs.existsSync(cliPath)) {
                return cliPath;
            }
        }
        
        // Check %USERPROFILE%\.claude\ (alternative Windows location)
        const dotClaudePath = path.join(homeDir, '.claude');
        if (fs.existsSync(dotClaudePath)) {
            const versionsDir = path.join(dotClaudePath, 'versions');
            if (fs.existsSync(versionsDir)) {
                const found = findLatestVersionBinary(versionsDir);
                if (found) return found;
            }
            
            const exePath = path.join(dotClaudePath, 'claude.exe');
            if (fs.existsSync(exePath)) {
                return exePath;
            }
        }
    }
    
    // Check ~/.local/bin/claude symlink (most common location on macOS/Linux)
    const localBinPath = path.join(homeDir, '.local', 'bin', 'claude');
    const resolvedLocalBinPath = resolvePathSafe(localBinPath);
    if (resolvedLocalBinPath) return resolvedLocalBinPath;
    
    // Check ~/.local/share/claude/versions/ (native installer location)
    const versionsDir = path.join(homeDir, '.local', 'share', 'claude', 'versions');
    if (fs.existsSync(versionsDir)) {
        const found = findLatestVersionBinary(versionsDir);
        if (found) return found;
    }
    
    // Check ~/.claude/local/ (older installation method)
    const nativeBasePath = path.join(homeDir, '.claude', 'local');
    if (fs.existsSync(nativeBasePath)) {
        // Look for the cli.js in the node_modules structure
        const cliPath = path.join(nativeBasePath, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        if (fs.existsSync(cliPath)) {
            return cliPath;
        }
        
        // Alternative: direct cli.js in the installation
        const directCliPath = path.join(nativeBasePath, 'cli.js');
        if (fs.existsSync(directCliPath)) {
            return directCliPath;
        }
    }
    
    return null;
}

/**
 * Helper to find the latest version binary in a versions directory
 * @param {string} versionsDir - Path to versions directory
 * @param {string} [binaryName] - Optional binary name to look for inside version directory
 * @returns {string|null} Path to binary or null
 */
function findLatestVersionBinary(versionsDir, binaryName = null) {
    try {
        const entries = fs.readdirSync(versionsDir);
        if (entries.length === 0) return null;
        
        // Sort using semver comparison (descending)
        const sorted = entries.sort((a, b) => compareVersions(b, a));
        const latestVersion = sorted[0];
        const versionPath = path.join(versionsDir, latestVersion);
        
        // Check if it's a file (binary) or directory
        const stat = fs.statSync(versionPath);
        if (stat.isFile()) {
            return versionPath;
        } else if (stat.isDirectory()) {
            // If specific binary name provided, check for it
            if (binaryName) {
                const binaryPath = path.join(versionPath, binaryName);
                if (fs.existsSync(binaryPath)) {
                    return binaryPath;
                }
            }
            // Check for executable or cli.js inside directory
            const exePath = path.join(versionPath, process.platform === 'win32' ? 'claude.exe' : 'claude');
            if (fs.existsSync(exePath)) {
                return exePath;
            }
            const cliPath = path.join(versionPath, 'cli.js');
            if (fs.existsSync(cliPath)) {
                return cliPath;
            }
        }
    } catch (e) {}
    return null;
}

/**
 * Find path to globally installed Claude Code CLI
 * Priority: HAPPY_CLAUDE_PATH env var > PATH > npm > Bun > Homebrew > Native
 * @returns {{path: string, source: string}|null} Path and source, or null if not found
 */
function findGlobalClaudeCliPath() {
    // 1. Environment variable (explicit override)
    const envPath = process.env.HAPPY_CLAUDE_PATH;
    if (envPath && fs.existsSync(envPath)) {
        const resolved = resolvePathSafe(envPath) || envPath;
        return { path: resolved, source: 'HAPPY_CLAUDE_PATH' };
    }

    // 2. Check PATH (respects user's shell config)
    const pathResult = findClaudeInPath();
    if (pathResult) return pathResult;

    // 3. Fall back to package manager detection
    const npmPath = findNpmGlobalCliPath();
    if (npmPath) return { path: npmPath, source: 'npm' };

    const bunPath = findBunGlobalCliPath();
    if (bunPath) return { path: bunPath, source: 'Bun' };

    const homebrewPath = findHomebrewCliPath();
    if (homebrewPath) return { path: homebrewPath, source: 'Homebrew' };

    const nativePath = findNativeInstallerCliPath();
    if (nativePath) return { path: nativePath, source: 'native installer' };

    return null;
}

/**
 * Get version from Claude Code package.json
 * @param {string} cliPath - Path to cli.js
 * @returns {string|null} Version string or null
 */
function getVersion(cliPath) {
    // For cli.js / cli-wrapper.cjs the sibling package.json exists.
    // For bin/claude[.exe] the package.json lives one level up.
    const candidates = [path.dirname(cliPath), path.dirname(path.dirname(cliPath))];
    for (const dir of candidates) {
        try {
            const pkgPath = path.join(dir, 'package.json');
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                // Strict name match prevents grabbing an unrelated package.json
                // (e.g. NVM's own) when cliPath is a dangling/misrouted shim.
                if (pkg && pkg.version && pkg.name === '@anthropic-ai/claude-code') {
                    return pkg.version;
                }
            }
        } catch (e) {}
    }

    // Native installer fallback: version encoded in path under a `versions/<semver>/`
    // segment. Layouts in the wild:
    //   ~/.local/share/claude/versions/<semver>/claude
    //   %LOCALAPPDATA%/Claude/versions/<semver>/claude.exe
    //   ~/.local/share/claude/versions/<semver>            (file directly named after version)
    // Strict semver regex avoids false positives from unrelated `versions/` dirs.
    const segments = path.normalize(cliPath).replace(/\\/g, '/').split('/');
    const semver = /^\d+\.\d+\.\d+(?:-[\w.+-]+)?$/;
    for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i] === 'versions' && i + 1 < segments.length && semver.test(segments[i + 1])) {
            return segments[i + 1];
        }
    }
    return null;
}

/**
 * Compare semver versions
 * @param {string} a - First version
 * @param {string} b - Second version
 * @returns {number} 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a, b) {
    if (!a || !b) return 0;
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (partsA[i] > partsB[i]) return 1;
        if (partsA[i] < partsB[i]) return -1;
    }
    return 0;
}

/**
 * Get the CLI path to use (global installation)
 * @returns {string} Path to cli.js
 * @throws {Error} If no global installation found
 */
function getClaudeCliPath() {
    const result = findGlobalClaudeCliPath();
    if (!result) {
        console.error('\n\x1b[1m\x1b[33mClaude Code is not installed\x1b[0m\n');
        console.error('Please install Claude Code using one of these methods:\n');
        console.error('\x1b[1mOption 1 - npm (recommended, highest priority):\x1b[0m');
        console.error('  \x1b[36mnpm install -g @anthropic-ai/claude-code\x1b[0m\n');
        console.error('\x1b[1mOption 2 - Homebrew (macOS/Linux):\x1b[0m');
        console.error('  \x1b[36mbrew install claude-code\x1b[0m\n');
        console.error('\x1b[1mOption 3 - Native installer:\x1b[0m');
        console.error('  \x1b[90mmacOS/Linux:\x1b[0m  \x1b[36mcurl -fsSL https://claude.ai/install.sh | bash\x1b[0m');
        console.error('  \x1b[90mPowerShell:\x1b[0m   \x1b[36mirm https://claude.ai/install.ps1 | iex\x1b[0m');
        console.error('  \x1b[90mWindows CMD:\x1b[0m  \x1b[36mcurl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd\x1b[0m\n');
        console.error('\x1b[90mNote: If multiple installations exist, npm takes priority.\x1b[0m\n');
        process.exit(1);
    }

    const version = getVersion(result.path);
    const versionStr = version ? ` v${version}` : '';
    console.error(`\x1b[90mUsing Claude Code${versionStr} from ${result.source}\x1b[0m`);

    return result.path;
}

/**
 * Run Claude CLI, handling both JavaScript and binary files
 * @param {string} cliPath - Path to CLI (from getClaudeCliPath)
 */
function runClaudeCli(cliPath) {
    const { pathToFileURL } = require('url');
    const { spawn } = require('child_process');
    
    // Check if it's a JavaScript file (.js or .cjs) or a binary file
    const isJsFile = cliPath.endsWith('.js') || cliPath.endsWith('.cjs');

    if (isJsFile) {
        // JavaScript file - use import to keep interceptors working
        const importUrl = pathToFileURL(cliPath).href;
        import(importUrl);
    } else {
        // Binary file (e.g., Homebrew installation) - spawn directly
        // Note: Interceptors won't work with binary files, but that's acceptable
        // as binary files are self-contained and don't need interception
        const args = process.argv.slice(2);
        const child = spawn(cliPath, args, {
            stdio: 'inherit',
            env: process.env
        });
        child.on('exit', (code) => {
            process.exit(code || 0);
        });
    }
}

module.exports = {
    findGlobalClaudeCliPath,
    findClaudeInPath,
    detectSourceFromPath,
    findNpmGlobalCliPath,
    findBunGlobalCliPath,
    findClaudeInBunHome,
    findHomebrewCliPath,
    findClaudeInHomebrewPrefix,
    findNativeInstallerCliPath,
    resolveClaudeEntryInPkg,
    walkUpToPkgEntry,
    getVersion,
    compareVersions,
    getClaudeCliPath,
    runClaudeCli
};

