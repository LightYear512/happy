// Build the tested turn-publication repair on an installed release, preserving
// unrelated runtime fixes. Activation and session restart are separate actions.
import { cp, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const [baseArg, outputArg] = process.argv.slice(2);
if (!baseArg || !outputArg) throw new Error('Usage: node scripts/build-claude-turn-order-release.mjs BASE_RELEASE NEW_RELEASE');
const base = await realpath(baseArg), output = resolve(outputArg);
const pkg = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
if (pkg.name !== 'happy-coder') throw new Error('Expected an installed Happy release');
const replacements = [
    ['if (opts.onErrorResult) opts.onErrorResult(message);', 'if (opts.onErrorResult) await opts.onErrorResult(message);'],
    ['opts.onErrorResult(errorText);', 'await opts.onErrorResult(errorText);'],
    ['opts.onReady();', 'await opts.onReady();'],
    ['onReady: () => {\n            session.client.closeClaudeSessionTurn("completed");',
        'onReady: async () => {\n            await messageQueue.flush();\n            session.client.closeClaudeSessionTurn("completed");'],
    ['onErrorResult: (message) => {\n            session.client.closeClaudeSessionTurn("failed");',
        'onErrorResult: async (message) => {\n            await messageQueue.flush();\n            session.client.closeClaudeSessionTurn("failed");'],
];
const patches = [];
for (const ext of ['mjs', 'cjs']) {
    const candidates = [];
    for (const name of await readdir(join(base, 'dist'))) {
        if (!name.startsWith('index-') || !name.endsWith(`.${ext}`)) continue;
        const original = await readFile(join(base, 'dist', name), 'utf8');
        if (original.includes('async function claudeRemote(opts)')) candidates.push({ name, original });
    }
    if (candidates.length !== 1) throw new Error(`Expected one ${ext} Claude implementation`);
    const { name, original } = candidates[0];
    let updated = original;
    for (const [before, after] of replacements) {
        if (updated.split(before).length !== 2) throw new Error(`Expected one exact repair site: ${name}: ${before}`);
        updated = updated.replace(before, after);
    }
    patches.push({ name, original, updated });
}
await mkdir(output);
for (const name of ['dist', 'scripts', 'bin', 'package.json']) {
    await cp(join(base, name), join(output, name), { recursive: true, verbatimSymlinks: true });
}
await symlink(await realpath(join(base, 'node_modules')), join(output, 'node_modules'), 'dir');
for (const patch of patches) await writeFile(join(output, 'dist', patch.name), patch.updated);
const digest = text => createHash('sha256').update(text).digest('hex');
const receipt = { base, output, patches: patches.map(patch => ({ file: patch.name,
    beforeSha256: digest(patch.original), afterSha256: digest(patch.updated) })) };
await writeFile(join(output, 'turn-order-build.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
