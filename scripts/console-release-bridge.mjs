/** One-time console-only upgrade for a daemon that still owns active user tasks. */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function renderConsoleBridge(targetEntry, originalFilename) {
    // Match only the daemon's exact console invocation. No user task or daemon
    // startup may change version merely because an environment flag was inherited.
    return `// Happy console-only release bridge; original entry retained beside this file.\n`
        + `const consoleArgs = ['codex', '--happy-starting-mode', 'remote', '--started-by', 'daemon'];\n`
        + `const args = process.argv.slice(2);\n`
        + `const consoleOnly = process.env.HAPPY_CONSOLE_SESSION === '1'\n`
        + `    && args.length === consoleArgs.length && args.every((arg, i) => arg === consoleArgs[i]);\n`
        + `await import(consoleOnly ? ${JSON.stringify(pathToFileURL(targetEntry).href)}\n`
        + `    : ${JSON.stringify('./' + originalFilename)});\n`;
}

function checkRelease(root) {
    const resolved = realpathSync(root);
    const pkg = JSON.parse(readFileSync(join(resolved, 'package.json'), 'utf8'));
    if (pkg.name !== 'happy-coder') throw new Error('Expected an installed happy-coder release');
    const entry = join(resolved, 'dist', 'index.mjs');
    if (!lstatSync(entry).isFile()) throw new Error('Release entry must be a regular file, not a symlink');
    const bytes = readFileSync(entry);
    // pkgroll's entry is a side-effect-import-only facade. Keep all imports in
    // the original sibling facade, preserving resolution and evaluation order.
    const lines = bytes.toString('utf8').split('\n').filter(line => line.trim());
    if (!lines.length || !lines.every(line => /^import ['"][^'"\r\n]+['"];\s*$/u.test(line))) {
        throw new Error('Unknown or already bridged entry; refusing to rewrite it');
    }
    return { root: resolved, entry, bytes, mode: statSync(entry).mode & 0o777 };
}

export function installConsoleBridge(oldRoot, newRoot, expectedDigest) {
    const old = checkRelease(oldRoot);
    const next = checkRelease(newRoot);
    if (old.root === next.root || dirname(old.root) !== dirname(next.root)) {
        throw new Error('Expected two distinct sibling release directories');
    }
    const digest = sha256(old.bytes);
    if (!/^[a-f0-9]{64}$/u.test(expectedDigest) || digest !== expectedDigest) {
        throw new Error('Original entry checksum changed; refusing to overwrite it');
    }
    const originalFilename = `index.console-original-${digest}.mjs`;
    const backup = join(dirname(old.entry), originalFilename);
    const bridge = renderConsoleBridge(next.entry, originalFilename);
    const directory = dirname(old.entry);
    const directoryMode = statSync(directory).mode & 0o777;
    const temporary = join(directory, `.console-entry-${randomUUID()}.mjs`);
    try {
        // Only this launcher directory is writable during the atomic switch;
        // hashed bundles, dependency files and running processes remain untouched.
        chmodSync(directory, directoryMode | 0o200);
        if (existsSync(backup)) {
            if (!lstatSync(backup).isFile() || !readFileSync(backup).equals(old.bytes)) {
                throw new Error('Original entry backup conflicts with current entry');
            }
        } else {
            writeFileSync(backup, old.bytes, { flag: 'wx', mode: old.mode });
        }
        writeFileSync(temporary, bridge, { flag: 'wx', mode: old.mode });
        if (sha256(readFileSync(old.entry)) !== digest) {
            throw new Error('Entry changed during preparation; no replacement performed');
        }
        renameSync(temporary, old.entry);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
        chmodSync(directory, directoryMode);
    }
    return { entry: old.entry, originalEntry: backup, originalSha256: digest,
        bridgeSha256: sha256(bridge), targetEntry: next.entry };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 5) {
        throw new Error('Usage: node scripts/console-release-bridge.mjs OLD_RELEASE NEW_RELEASE EXPECTED_ENTRY_SHA256');
    }
    console.log(JSON.stringify(installConsoleBridge(...process.argv.slice(2)), null, 2));
}
