import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
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
  compareVersions
} from '../scripts/claude_version_utils.cjs';

describe('Claude Version Utils - Cross-Platform Detection', () => {

  describe('detectSourceFromPath', () => {

    describe('npm installations', () => {
      it('should detect npm global installation on macOS/Linux', () => {
        const result = detectSourceFromPath('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js');
        expect(result).toBe('npm');
      });

      it('should detect npm global installation on Windows with forward slashes', () => {
        const result = detectSourceFromPath('C:/Users/test/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js');
        expect(result).toBe('npm');
      });

      it('should detect npm global installation on Windows with backslashes', () => {
        const result = detectSourceFromPath('C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js');
        expect(result).toBe('npm');
      });

      it('should detect npm with different scoped packages', () => {
        const result = detectSourceFromPath('C:/Users/test/AppData/Roaming/npm/node_modules/@babel/core/cli.js');
        expect(result).toBe('npm');
      });

      it('should detect npm through Homebrew', () => {
        const result = detectSourceFromPath('/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js');
        expect(result).toBe('npm');
      });

      it('should NOT detect Homebrew cask as npm', () => {
        const result = detectSourceFromPath('/opt/homebrew/lib/node_modules/@anthropic-ai/.claude-code-2DTsDk1V/cli.js');
        expect(result).toBe('Homebrew');
      });
    });

    describe('Bun installations', () => {
      it('should detect Bun global installation on Unix', () => {
        const result = detectSourceFromPath('/Users/test/.bun/bin/claude');
        expect(result).toBe('Bun');
      });

      it('should detect Bun global installation on Windows', () => {
        const result = detectSourceFromPath('C:/Users/test/.bun/bin/claude');
        expect(result).toBe('Bun');
      });

      it('should detect Bun with @ symbol in username', () => {
        const result = detectSourceFromPath('C:/Users/@specialuser/.bun/bin/claude');
        expect(result).toBe('Bun');
      });

      it('should detect Bun in node_modules context', () => {
        const result = detectSourceFromPath('/Users/test/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js');
        expect(result).toBe('Bun');
      });
    });

    describe('Homebrew installations', () => {
      const _originalPlatform = process.platform;
      afterEach(() => {
        Object.defineProperty(process, 'platform', { value: _originalPlatform, configurable: true });
      });

      it('should detect Homebrew on Apple Silicon macOS', () => {
        const result = detectSourceFromPath('/opt/homebrew/bin/claude');
        expect(result).toBe('Homebrew');
      });

      it('should detect Homebrew on Intel macOS', () => {
        // Mock macOS platform
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

        const result = detectSourceFromPath('/usr/local/bin/claude');
        expect(result).toBe('Homebrew');

        // Restore original platform
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      });

      it('should detect native installer on Linux for /usr/local/bin/claude', () => {
        // Mock Linux platform
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

        const result = detectSourceFromPath('/usr/local/bin/claude');
        expect(result).toBe('native installer');

        // Restore original platform
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      });

      it('should detect Homebrew on Linux', () => {
        const result = detectSourceFromPath('/home/linuxbrew/.linuxbrew/bin/claude');
        expect(result).toBe('Homebrew');
      });

      it('should detect Homebrew user installation', () => {
        const result = detectSourceFromPath('/Users/test/.linuxbrew/bin/claude');
        expect(result).toBe('Homebrew');
      });

      it('should detect Homebrew cask with hashed directory', () => {
        const result = detectSourceFromPath('/opt/homebrew/lib/node_modules/@anthropic-ai/.claude-code-2DTsDk1V/cli.js');
        expect(result).toBe('Homebrew');
      });

      it('should detect Homebrew Cellar installation', () => {
        const result = detectSourceFromPath('/opt/homebrew/Cellar/claude-code/1.0.0/bin/claude');
        expect(result).toBe('Homebrew');
      });
    });

    describe('Native installer installations', () => {
      it('should detect native installer on Unix ~/.local', () => {
        const result = detectSourceFromPath('/Users/test/.local/bin/claude');
        expect(result).toBe('native installer');
      });

      it('should detect native installer with versioned structure', () => {
        const result = detectSourceFromPath('/Users/test/.local/share/claude/versions/2.0.69/claude');
        expect(result).toBe('native installer');
      });

      it('should detect native installer on Windows Program Files', () => {
        const result = detectSourceFromPath('C:/Program Files/Claude/claude.exe');
        expect(result).toBe('native installer');
      });

      it('should detect native installer on Windows AppData', () => {
        const result = detectSourceFromPath('C:/Users/test/AppData/Local/Claude/claude.exe');
        expect(result).toBe('native installer');
      });

      it('should detect native installer on Windows custom location', () => {
        const result = detectSourceFromPath('E:/Tools/Claude/claude.exe');
        expect(result).toBe('native installer');
      });

      it('should detect native installer on Windows D: drive', () => {
        const result = detectSourceFromPath('D:/Development/Claude/claude.exe');
        expect(result).toBe('native installer');
      });

      it('should detect native installer in user profile', () => {
        const result = detectSourceFromPath('C:/Users/test/.claude/claude.exe');
        expect(result).toBe('native installer');
      });
    });

    describe('Edge cases and special characters', () => {
      it('should handle @ symbols in paths correctly', () => {
        const result = detectSourceFromPath('/Users/@developer/test/node_modules/@anthropic-ai/claude-code/cli.js');
        expect(result).toBe('npm');
      });

      it('should handle case sensitivity variations on Windows', () => {
        const result = detectSourceFromPath('C:/USERS/TEST/APPDATA/ROAMING/NPM/NODE_MODULES/@ANTHROPIC-AI/CLAUDE-CODE/CLI.JS');
        expect(result).toBe('npm');
      });

      it('should return PATH for unrecognized paths', () => {
        const result = detectSourceFromPath('/some/random/path/claude');
        expect(result).toBe('PATH');
      });

      it('should handle empty paths', () => {
        const result = detectSourceFromPath('');
        expect(result).toBe('PATH');
      });

      it('should handle relative paths', () => {
        const result = detectSourceFromPath('./local/bin/claude');
        expect(result).toBe('PATH');
      });
    });
  });

  describe('Cross-platform compatibility', () => {
    it('should handle both forward and backward slashes', () => {
      const forward = detectSourceFromPath('C:/Users/test/AppData/Local/Claude/claude.exe');
      const backward = detectSourceFromPath('C:\\Users\\test\\AppData\\Local\\Claude\\claude.exe');

      expect(forward).toBe('native installer');
      expect(backward).toBe('native installer');
    });

    it('should handle Windows drive letters', () => {
      const drives = ['C:', 'D:', 'E:', 'Z:'];
      drives.forEach(drive => {
        const result = detectSourceFromPath(`${drive}/Program Files/Claude/claude.exe`);
        expect(result).toBe('native installer');
      });
    });

    it('should handle Unix-style absolute paths', () => {
      // Only platform-agnostic paths here — `/usr/local/bin/claude` resolves to
      // Homebrew on darwin and native installer on linux, so it lives in the
      // platform-mocked tests above, not this generic case.
      const unixPaths = [
        '/opt/homebrew/bin/claude',
        '/home/user/.local/bin/claude'
      ];

      unixPaths.forEach(path => {
        const result = detectSourceFromPath(path);
        expect(['Homebrew', 'native installer']).toContain(result);
      });
    });
  });

  describe('Version comparison', () => {
    it('should compare versions correctly', () => {
      expect(compareVersions('2.0.69', '2.0.68')).toBe(1);
      expect(compareVersions('2.0.68', '2.0.69')).toBe(-1);
      expect(compareVersions('2.0.69', '2.0.69')).toBe(0);
      expect(compareVersions('2.1.0', '2.0.69')).toBe(1);
      expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    });

    it('should handle malformed versions gracefully', () => {
      expect(() => compareVersions('', '2.0.0')).not.toThrow();
      expect(() => compareVersions('invalid', '2.0.0')).not.toThrow();
      expect(() => compareVersions('2.0.0', '')).not.toThrow();
    });
  });

  describe('Integration scenarios', () => {
    it('should handle multiple installations scenario', () => {
      const scenarios = [
        { path: '/Users/test/.bun/bin/claude', expected: 'Bun' },
        { path: '/opt/homebrew/bin/claude', expected: 'Homebrew' },
        { path: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', expected: 'npm' },
        { path: 'C:/Program Files/Claude/claude.exe', expected: 'native installer' }
      ];

      scenarios.forEach(({ path, expected }) => {
        const result = detectSourceFromPath(path);
        expect(result).toBe(expected);
      });
    });

    it('should maintain 100% success rate on all standard installation patterns', () => {
      const standardPatterns = [
        // npm (most common)
        { path: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', expected: 'npm' },
        { path: 'C:/Users/test/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js', expected: 'npm' },

        // bun (second most common)
        { path: '/Users/test/.bun/bin/claude', expected: 'Bun' },
        { path: 'C:/Users/test/.bun/bin/claude', expected: 'Bun' },

        // homebrew (macOS and Linux)
        { path: '/opt/homebrew/bin/claude', expected: 'Homebrew' },
        { path: '/home/linuxbrew/.linuxbrew/bin/claude', expected: 'Homebrew' },
        { path: '/Users/test/.linuxbrew/bin/claude', expected: 'Homebrew' }, // LinuxBrew user installation

        // native installers
        { path: 'C:/Program Files/Claude/claude.exe', expected: 'native installer' },
        { path: 'C:/Users/test/AppData/Local/Claude/claude.exe', expected: 'native installer' },
        { path: '/Users/test/.local/bin/claude', expected: 'native installer' }
      ];

      let passed = 0;
      standardPatterns.forEach(({ path, expected }) => {
        const result = detectSourceFromPath(path);
        if (result === expected) passed++;
      });

      expect(passed).toBe(standardPatterns.length);
      expect(passed / standardPatterns.length).toBe(1); // 100% success rate
    });

    it('should handle platform-specific /usr/local/bin/claude correctly', () => {
      const originalPlatform = process.platform;

      // Test on macOS (should be Homebrew)
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const macosResult = detectSourceFromPath('/usr/local/bin/claude');
      expect(macosResult).toBe('Homebrew');

      // Test on Linux (should be native installer)
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const linuxResult = detectSourceFromPath('/usr/local/bin/claude');
      expect(linuxResult).toBe('native installer');

      // Test on Windows (should fallback to PATH)
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const windowsResult = detectSourceFromPath('/usr/local/bin/claude');
      expect(windowsResult).toBe('PATH');

      // Restore original platform
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
  });

  describe('Real-world edge cases', () => {
    it('should handle complex user scenarios', () => {
      const edgeCases = [
        // User with npm aliased to bun
        { path: '/Users/test/node_modules/@anthropic-ai/claude-code/cli.js', expected: 'npm' },

        // Multiple package managers
        { path: '/Users/test/.bun/bin/claude', expected: 'Bun' },
        { path: '/opt/homebrew/bin/claude', expected: 'Homebrew' },

        // Custom installations
        { path: '/opt/custom/claude/bin/claude', expected: 'PATH' },
        { path: '/usr/local/custom/bin/claude', expected: 'PATH' }
      ];

      edgeCases.forEach(({ path, expected }) => {
        const result = detectSourceFromPath(path);
        expect(result).toBe(expected);
      });
    });

    it('should handle path traversal and normalization', () => {
      const pathNormalizationTests = [
        { input: '/opt/homebrew/bin/../lib/claude', expected: 'Homebrew' },
        { input: '/Users/test/.bun/bin/./claude', expected: 'Bun' },
        { input: 'C:/Users/test/../test/AppData/Local/Claude/claude.exe', expected: 'native installer' }
      ];

      pathNormalizationTests.forEach(({ input, expected }) => {
        const result = detectSourceFromPath(input);
        expect(result).toBe(expected);
      });
    });
  });
});

describe('HAPPY_CLAUDE_PATH env var', () => {
  const testClaudePath = '/tmp/test-claude-path';

  beforeEach(() => {
    // Create mock executable
    fs.writeFileSync(testClaudePath, '#!/bin/bash\necho "mock"');
    fs.chmodSync(testClaudePath, 0o755);
  });

  afterEach(() => {
    if (fs.existsSync(testClaudePath)) fs.unlinkSync(testClaudePath);
    delete process.env.HAPPY_CLAUDE_PATH;
  });

  it('should use HAPPY_CLAUDE_PATH when set', () => {
    process.env.HAPPY_CLAUDE_PATH = testClaudePath;
    const result = findGlobalClaudeCliPath();
    expect(result?.source).toBe('HAPPY_CLAUDE_PATH');
    // Use realpathSync to handle macOS symlink (/tmp -> /private/tmp)
    expect(fs.realpathSync(result?.path ?? '')).toBe(fs.realpathSync(testClaudePath));
  });

  it('should fall back to auto-discovery when env var not set', () => {
    const result = findGlobalClaudeCliPath();
    expect(result?.source).not.toBe('HAPPY_CLAUDE_PATH');
  });

  it('should ignore env var if path does not exist', () => {
    process.env.HAPPY_CLAUDE_PATH = '/nonexistent/path/claude';
    const result = findGlobalClaudeCliPath();
    expect(result?.source).not.toBe('HAPPY_CLAUDE_PATH');
  });
});

describe('resolveClaudeEntryInPkg - package layout detection', () => {
  let tmpRoot: string;
  let pkgDir: string;
  let binName: string;
  const originalPlatform = process.platform;

  beforeEach(() => {
    // Earlier tests in this file mutate process.platform and occasionally leak
    // the mutation when an assertion throws before the restore line. Reset
    // defensively so binName reflects the real host platform.
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-entry-test-'));
    pkgDir = path.join(tmpRoot, 'claude-code');
    fs.mkdirSync(pkgDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns null for null / empty pkgDir', () => {
    expect(resolveClaudeEntryInPkg(null)).toBeNull();
    expect(resolveClaudeEntryInPkg('')).toBeNull();
  });

  it('returns null for non-existent directory', () => {
    expect(resolveClaudeEntryInPkg(path.join(tmpRoot, 'nope'))).toBeNull();
  });

  it('returns null for empty package directory', () => {
    expect(resolveClaudeEntryInPkg(pkgDir)).toBeNull();
  });

  it('legacy: returns cli.js when it is the only entry', () => {
    const cliJs = path.join(pkgDir, 'cli.js');
    fs.writeFileSync(cliJs, '// legacy');
    expect(resolveClaudeEntryInPkg(pkgDir)).toBe(cliJs);
  });

  it('new wrapper: returns cli-wrapper.cjs when it is the only entry', () => {
    const wrapper = path.join(pkgDir, 'cli-wrapper.cjs');
    fs.writeFileSync(wrapper, '// wrapper');
    expect(resolveClaudeEntryInPkg(pkgDir)).toBe(wrapper);
  });

  it('binary: returns bin/claude[.exe] when it is the only entry', () => {
    fs.mkdirSync(path.join(pkgDir, 'bin'));
    const binPath = path.join(pkgDir, 'bin', binName);
    fs.writeFileSync(binPath, 'binary');
    expect(resolveClaudeEntryInPkg(pkgDir)).toBe(binPath);
  });

  it('priority: cli.js beats cli-wrapper.cjs when both present', () => {
    fs.writeFileSync(path.join(pkgDir, 'cli.js'), '// legacy');
    fs.writeFileSync(path.join(pkgDir, 'cli-wrapper.cjs'), '// wrapper');
    expect(resolveClaudeEntryInPkg(pkgDir)).toBe(path.join(pkgDir, 'cli.js'));
  });

  it('priority: cli-wrapper.cjs beats bin/claude when both present', () => {
    fs.writeFileSync(path.join(pkgDir, 'cli-wrapper.cjs'), '// wrapper');
    fs.mkdirSync(path.join(pkgDir, 'bin'));
    fs.writeFileSync(path.join(pkgDir, 'bin', binName), 'binary');
    expect(resolveClaudeEntryInPkg(pkgDir)).toBe(path.join(pkgDir, 'cli-wrapper.cjs'));
  });

  it('priority: cli.js wins even when all three coexist (protects against stale artifacts)', () => {
    fs.writeFileSync(path.join(pkgDir, 'cli.js'), '// legacy');
    fs.writeFileSync(path.join(pkgDir, 'cli-wrapper.cjs'), '// wrapper');
    fs.mkdirSync(path.join(pkgDir, 'bin'));
    fs.writeFileSync(path.join(pkgDir, 'bin', binName), 'binary');
    expect(resolveClaudeEntryInPkg(pkgDir)).toBe(path.join(pkgDir, 'cli.js'));
  });
});

describe('getVersion - claude-code package.json extraction', () => {
  let tmpRoot: string;
  let pkgDir: string;
  let binName: string;
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-getver-test-'));
    pkgDir = path.join(tmpRoot, 'claude-code');
    fs.mkdirSync(pkgDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writePkg(version: string, name: string = '@anthropic-ai/claude-code') {
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
  }

  it('reads version from sibling package.json for cli.js', () => {
    writePkg('2.1.50');
    const cliJs = path.join(pkgDir, 'cli.js');
    fs.writeFileSync(cliJs, '// legacy');
    expect(getVersion(cliJs)).toBe('2.1.50');
  });

  it('reads version from sibling package.json for cli-wrapper.cjs', () => {
    writePkg('2.1.114');
    const wrapper = path.join(pkgDir, 'cli-wrapper.cjs');
    fs.writeFileSync(wrapper, '// wrapper');
    expect(getVersion(wrapper)).toBe('2.1.114');
  });

  it('reads version from parent package.json for bin/claude[.exe]', () => {
    writePkg('2.1.114');
    fs.mkdirSync(path.join(pkgDir, 'bin'));
    const binPath = path.join(pkgDir, 'bin', binName);
    fs.writeFileSync(binPath, 'binary');
    expect(getVersion(binPath)).toBe('2.1.114');
  });

  it('rejects package.json with wrong package name (prevents NVM/grandparent leak)', () => {
    writePkg('24.10.0', 'node');
    const cliJs = path.join(pkgDir, 'cli.js');
    fs.writeFileSync(cliJs, '// not claude-code');
    expect(getVersion(cliJs)).toBeNull();
  });

  it('returns null when no package.json on path (native installer standalone binary)', () => {
    const standaloneBin = path.join(tmpRoot, '2.1.41');
    fs.writeFileSync(standaloneBin, 'binary');
    expect(getVersion(standaloneBin)).toBeNull();
  });

  it('handles malformed package.json gracefully', () => {
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{ not valid json');
    const cliJs = path.join(pkgDir, 'cli.js');
    fs.writeFileSync(cliJs, '// legacy');
    expect(getVersion(cliJs)).toBeNull();
  });
});

describe('getVersion - native installer path-name fallback', () => {
  it('extracts semver from ~/.local/share/claude/versions/<x.y.z>/claude', () => {
    expect(getVersion('/home/user/.local/share/claude/versions/2.1.114/claude')).toBe('2.1.114');
  });

  it('extracts semver from Windows %LOCALAPPDATA%/Claude/versions/<x.y.z>/claude.exe', () => {
    expect(getVersion('C:\\Users\\test\\AppData\\Local\\Claude\\versions\\2.1.114\\claude.exe')).toBe('2.1.114');
  });

  it('extracts semver with pre-release suffix', () => {
    expect(getVersion('/home/user/.local/share/claude/versions/2.1.114-beta.1/claude')).toBe('2.1.114-beta.1');
  });

  it('returns null when versions/ segment is followed by non-semver name', () => {
    expect(getVersion('/home/user/.local/share/claude/versions/foo/claude')).toBeNull();
  });

  it('returns null when path has no versions/ segment', () => {
    expect(getVersion('/usr/local/bin/claude')).toBeNull();
  });

  it('picks the last (deepest) versions/ segment when multiple exist', () => {
    // Defensive: if a path coincidentally has nested 'versions' dirs, take the most
    // specific one. Right-to-left scan in the implementation.
    expect(getVersion('/opt/versions/legacy/claude/versions/2.1.114/claude')).toBe('2.1.114');
  });
});

describe('findClaudeInBunHome - integration with mkdtemp', () => {
  let tmpHome: string;
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-home-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function makeBunBin() {
    // bunBin path that findClaudeInBunHome reads: <home>/.bun/bin/claude
    const bunBinDir = path.join(tmpHome, '.bun', 'bin');
    fs.mkdirSync(bunBinDir, { recursive: true });
    const bunBin = path.join(bunBinDir, 'claude');
    fs.writeFileSync(bunBin, 'fake bun shim');
    return bunBin;
  }

  it('returns null when .bun/bin/claude does not exist', () => {
    expect(findClaudeInBunHome(tmpHome)).toBeNull();
  });

  it('walks up from .bun/bin to find cli-wrapper.cjs at .bun root', () => {
    // Simulate pkg root co-located at .bun/ — walk-up from .bun/bin discovers it.
    makeBunBin();
    const wrapper = path.join(tmpHome, '.bun', 'cli-wrapper.cjs');
    fs.writeFileSync(wrapper, '// wrapper');
    expect(findClaudeInBunHome(tmpHome)).toBe(wrapper);
  });

  it('prefers cli.js over cli-wrapper.cjs found via walk-up', () => {
    makeBunBin();
    const cliJs = path.join(tmpHome, '.bun', 'cli.js');
    fs.writeFileSync(cliJs, '// legacy');
    fs.writeFileSync(path.join(tmpHome, '.bun', 'cli-wrapper.cjs'), '// wrapper');
    expect(findClaudeInBunHome(tmpHome)).toBe(cliJs);
  });

  it('returns null when pkg lives deeper than PKG_WALKUP_DEPTH allows', () => {
    // Pkg buried at .bun/install/global/node_modules/@anthropic-ai/claude-code/
    // is more than 3 levels above .bun/bin — walk-up should fail closed.
    makeBunBin();
    const deepPkg = path.join(tmpHome, '.bun', 'install', 'global', 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(deepPkg, { recursive: true });
    fs.writeFileSync(path.join(deepPkg, 'cli.js'), '// legacy');
    expect(findClaudeInBunHome(tmpHome)).toBeNull();
  });
});

describe('findClaudeInHomebrewPrefix - integration with mkdtemp', () => {
  let tmpPrefix: string;
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    tmpPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'brew-prefix-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpPrefix, { recursive: true, force: true });
  });

  it('returns null for an empty prefix', () => {
    expect(findClaudeInHomebrewPrefix(tmpPrefix)).toBeNull();
  });

  it('Layout A fallback: finds cli.js under lib/node_modules/@anthropic-ai/claude-code/', () => {
    // No <prefix>/bin/claude symlink — exercises the readdirSync fallback branch.
    const pkgDir = path.join(tmpPrefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkgDir, { recursive: true });
    const cliJs = path.join(pkgDir, 'cli.js');
    fs.writeFileSync(cliJs, '// legacy');
    expect(findClaudeInHomebrewPrefix(tmpPrefix)).toBe(cliJs);
  });

  it('Layout A fallback: handles hashed .claude-code-<hash> directories', () => {
    const pkgDir = path.join(tmpPrefix, 'lib', 'node_modules', '@anthropic-ai', '.claude-code-2DTsDk1V');
    fs.mkdirSync(pkgDir, { recursive: true });
    const wrapper = path.join(pkgDir, 'cli-wrapper.cjs');
    fs.writeFileSync(wrapper, '// wrapper');
    expect(findClaudeInHomebrewPrefix(tmpPrefix)).toBe(wrapper);
  });

  it('Layout B: returns standalone binary when bin/claude is the only entry', () => {
    // Cellar cask: <prefix>/bin/claude is a regular file (no node_modules layout).
    // Walk-up sees pkgRoot = <prefix>; resolver finds <prefix>/bin/claude as the
    // lowest-priority entry and returns it.
    const binDir = path.join(tmpPrefix, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, 'claude');
    fs.writeFileSync(binPath, 'binary');
    expect(findClaudeInHomebrewPrefix(tmpPrefix)).toBe(binPath);
  });

  it('Layout A wins over Layout B when both present (cli.js takes priority over standalone bin)', () => {
    // <prefix>/bin/claude exists AND <prefix>/cli.js exists at the resolved pkgRoot.
    // Resolver should prefer cli.js per documented priority.
    const binDir = path.join(tmpPrefix, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'claude'), 'binary');
    const cliJs = path.join(tmpPrefix, 'cli.js');
    fs.writeFileSync(cliJs, '// legacy');
    expect(findClaudeInHomebrewPrefix(tmpPrefix)).toBe(cliJs);
  });
});

describe('walkUpToPkgEntry - shared walk-up helper', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'walkup-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns null when no pkg found within depth', () => {
    expect(walkUpToPkgEntry(tmpRoot)).toBeNull();
  });

  it('finds entry at startDir itself (depth 0 hit)', () => {
    const cliJs = path.join(tmpRoot, 'cli.js');
    fs.writeFileSync(cliJs, '// legacy');
    expect(walkUpToPkgEntry(tmpRoot)).toBe(cliJs);
  });

  it('finds entry one level up (depth 1 hit)', () => {
    const child = path.join(tmpRoot, 'bin');
    fs.mkdirSync(child);
    const wrapper = path.join(tmpRoot, 'cli-wrapper.cjs');
    fs.writeFileSync(wrapper, '// wrapper');
    expect(walkUpToPkgEntry(child)).toBe(wrapper);
  });

  it('finds entry two levels up (depth 2 hit, last covered iteration)', () => {
    const grandchild = path.join(tmpRoot, 'a', 'b');
    fs.mkdirSync(grandchild, { recursive: true });
    const cliJs = path.join(tmpRoot, 'cli.js');
    fs.writeFileSync(cliJs, '// legacy');
    expect(walkUpToPkgEntry(grandchild)).toBe(cliJs);
  });

  it('returns null when pkg lies beyond default depth (PKG_WALKUP_DEPTH = 3)', () => {
    // Default depth = 3 means we probe iter 0/1/2 → startDir + 2 parents.
    // Burying the pkg at depth 3 (3 parents away) must NOT be found.
    const deep = path.join(tmpRoot, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'cli.js'), '// legacy');
    expect(walkUpToPkgEntry(deep)).toBeNull();
  });

  it('respects custom depth override', () => {
    const deep = path.join(tmpRoot, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'cli.js'), '// legacy');
    expect(walkUpToPkgEntry(deep, 4)).toBe(path.join(tmpRoot, 'cli.js'));
  });

  it('terminates at filesystem root without infinite loop', () => {
    // Use a deep depth + a path near root so the dirname fixed-point is hit
    // before depth runs out. If termination is broken, this would loop forever
    // and timeout instead of returning null cleanly.
    const root = path.parse(tmpRoot).root;
    expect(walkUpToPkgEntry(root, 100)).toBeNull();
  });
});