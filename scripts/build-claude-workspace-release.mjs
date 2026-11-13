// Build a narrow runtime repair from an installed release without including
// unrelated checkout changes. Activation and session lifecycle remain separate.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [baseArg, outputArg] = process.argv.slice(2);
if (!baseArg || !outputArg) throw new Error('Usage: node scripts/build-claude-workspace-release.mjs BASE_RELEASE NEW_RELEASE');
const base = await realpath(baseArg);
const output = resolve(outputArg);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/happy-cli');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const pkg = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
if (pkg.name !== 'happy-coder') throw new Error('Expected an installed Happy release');
const patches = [];

function replaceOnce(text, before, after) {
    if (text.split(before).length !== 2) throw new Error('Runtime layout changed; expected one exact repair site');
    return text.replace(before, after);
}

// Validate every patch before creating output. Never overwrite an existing release.
for (const ext of ['mjs', 'cjs']) {
    const candidates = [];
    for (const name of await readdir(join(base, 'dist'))) {
        if (!name.startsWith('index-') || !name.endsWith(`.${ext}`)) continue;
        const original = await readFile(join(base, 'dist', name), 'utf8');
        if (original.includes('function claudeCheckSession(sessionId, path) {')) candidates.push({ name, original });
    }
    if (candidates.length !== 1) throw new Error(`Expected one ${ext} Claude implementation`);
    const { name, original } = candidates[0];
    const pathJoin = ext === 'mjs' ? 'join' : 'node_path.join';
    const exists = ext === 'mjs' ? 'existsSync' : 'fs.existsSync';
    const log = ext === 'mjs' ? 'logger' : 'persistence.logger';
    let updated = replaceOnce(original,
        '  const projectDir = getProjectPath(path);\n'
        + `  const sessionFile = ${pathJoin}(projectDir, \`\${sessionId}.jsonl\`);\n`
        + `  const sessionExists = ${exists}(sessionFile);\n`
        + '  if (!sessionExists) {\n'
        + `    ${log}.debug(\`[claudeCheckSession] Path \${sessionFile} does not exist\`);`,
        '  const sessionFile = resolveHappyClaudeSessionFile(sessionId, path);\n'
        + '  if (!sessionFile) {\n'
        + `    ${log}.debug(\`[claudeCheckSession] No unambiguous transcript for \${sessionId}\`);`);
    updated = replaceOnce(updated,
        `await awaitFileExist(${pathJoin}(projectDir, \`\${systemInit.session_id}.jsonl\`))`,
        `await awaitFileExist(resolveHappyClaudeSessionFile(systemInit.session_id, opts.path) ?? ${pathJoin}(projectDir, \`\${systemInit.session_id}.jsonl\`))`);
    updated = replaceOnce(updated,
        '      const projDir = getProjectPath(currentSession.path);\n'
        + `      return ${pathJoin}(projDir, \`\${currentSession.sessionId}.jsonl\`);`,
        '      return resolveHappyClaudeSessionFile(currentSession.sessionId, currentSession.path);');
    const dependency = ext === 'mjs'
        ? "import { resolveClaudeSessionFile as resolveHappyClaudeSessionFile } from './workspace-resume.mjs';\n"
        : "const { resolveClaudeSessionFile: resolveHappyClaudeSessionFile } = require('./workspace-resume.cjs');\n";
    updated = ext === 'mjs' ? dependency + updated
        : replaceOnce(updated, "'use strict';", "'use strict';\n" + dependency);
    patches.push({ name, original, updated });
}

await mkdir(output);
for (const name of ['dist', 'scripts', 'bin', 'package.json']) {
    await cp(join(base, name), join(output, name), { recursive: true, verbatimSymlinks: true });
}
await symlink(await realpath(join(base, 'node_modules')), join(output, 'node_modules'), 'dir');
for (const ext of ['mjs', 'cjs']) {
    await build({ entryPoints: [join(sourceRoot, 'src/claude/utils/resolveClaudeSessionFile.ts')],
        outfile: join(output, 'dist', `workspace-resume.${ext}`), bundle: true,
        platform: 'node', format: ext === 'mjs' ? 'esm' : 'cjs', target: 'node20' });
}
for (const patch of patches) await writeFile(join(output, 'dist', patch.name), patch.updated);
const receipt = { base, output, patches: patches.map(p => ({ file: p.name,
    beforeSha256: sha256(p.original), afterSha256: sha256(p.updated) })) };
await writeFile(join(output, 'workspace-resume-build.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
