// Apply the verified startup changes to an installed release without rebuilding
// unrelated workspace edits. Activation and daemon handoff are separate steps.
import { cp, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const [baseArg, outputArg] = process.argv.slice(2);
if (!baseArg || !outputArg) throw new Error('Usage: node scripts/build-codex-startup-budget-release.mjs BASE NEW');
const base = await realpath(baseArg), output = resolve(outputArg);
if (JSON.parse(await readFile(join(base, 'package.json'), 'utf8')).name !== 'happy-coder') {
    throw new Error('Expected an installed Happy release');
}
const replacements = [
    ['const NEW_SESSION_REGISTRATION_TIMEOUT_MS = 2e4;', 'const NEW_SESSION_REGISTRATION_TIMEOUT_MS = 24e3;'],
    ['Number(rawDeadline) - 4e3', 'Number(rawDeadline) - 2e3'],
    [`      await session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        claudeSessionId: threadId
      }), { rejectOnServerError: true });
      threadIdStored = true;`, '      // Identity is persisted once by completeProviderInputReady below.'],
    [`        isCancelled: () => shouldExit
      });
      if (shouldExit) throw new CodexAccountSwapCancelled();`, `        isCancelled: () => shouldExit
      });
      if (threadId) threadIdStored = true;
      if (shouldExit) throw new CodexAccountSwapCancelled();`],
    [`    } else {
      session.onUserMessage(onUserMessage);
    }
    session.keepAlive(thinking, "remote");`, `    } else {
      if (threadId && !threadIdStored) {
        await session.updateMetadata(metadata => ({ ...metadata, claudeSessionId: threadId }), { rejectOnServerError: true });
        threadIdStored = true;
      }
      session.onUserMessage(onUserMessage);
    }
    session.keepAlive(thinking, "remote");`],
];
const patches = [];
for (const ext of ['mjs', 'cjs']) {
    const files = [];
    for (const name of await readdir(join(base, 'dist'))) {
        if (!name.endsWith(`.${ext}`)) continue;
        files.push({ name, original: await readFile(join(base, 'dist', name), 'utf8') });
    }
    for (const [sourceBefore, sourceAfter] of replacements) {
        const qualify = text => ext === 'cjs'
            ? text.replaceAll('new CodexAccountSwapCancelled()', 'new runCodex.CodexAccountSwapCancelled()') : text;
        const before = qualify(sourceBefore), after = qualify(sourceAfter);
        const matches = files.filter(file => file.original.includes(before)
            && (before.includes('NEW_SESSION_REGISTRATION_TIMEOUT_MS')
                || file.original.includes('async function startCodexThread(')));
        if (matches.length !== 1 || matches[0].original.split(before).length !== 2) {
            throw new Error(`Expected one exact ${ext} repair site: ${before}`);
        }
        const file = matches[0];
        file.updated = (file.updated ?? file.original).replace(before, after);
    }
    patches.push(...files.filter(file => file.updated !== undefined));
}
await mkdir(output);
for (const name of ['dist', 'scripts', 'bin', 'package.json']) {
    await cp(join(base, name), join(output, name), { recursive: true, verbatimSymlinks: true });
}
await symlink(await realpath(join(base, 'node_modules')), join(output, 'node_modules'), 'dir');
for (const patch of patches) await writeFile(join(output, 'dist', patch.name), patch.updated);
const hash = text => createHash('sha256').update(text).digest('hex');
const receipt = { base, output, patches: patches.map(patch => ({ file: patch.name,
    beforeSha256: hash(patch.original), afterSha256: hash(patch.updated) })) };
await writeFile(join(output, 'startup-budget-build.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
