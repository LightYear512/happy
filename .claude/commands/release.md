---
description: "Build, pack, and publish a GitHub Release with installable tarball (fork, no npm registry)"
argument-hint: "[patch|minor|major|<version>] [--branch <name>] [--prerelease] [--dry-run] [--skip-tests]"
---

# Release Skill — happy-cli (LightYear512/happy fork)

You are performing a release of the `happy-cli` package from this **fork**.
Since this is a fork, we publish via **GitHub Releases + tarball**, NOT npm registry.
Users install with:

```bash
npm install -g <tarball-url-from-github-release>
```

> ⚠️ **DO NOT use `yarn release`**. That script invokes `release-it` whose `.release-it.json`
> has `"npm": { "publish": true }`. Combined with `package.json#name = "happy"` (the same
> name as the upstream npm package), it would push the fork's code to the public npm
> registry and overwrite what upstream users get on `npm install -g happy`. This skill
> assembles `yarn build` / `yarn test` / `npm pack` / `git` / `gh release` manually so
> `npm publish` is never called. Only `.release-it.notes.js` is reused — it is a plain
> Node script for generating release notes text, independent of release-it's pipeline.

## Input

The user provides: `$ARGUMENTS`

Parse arguments:
- **Version**: `patch`, `minor`, `major`, or an explicit version string. If omitted, ask the user.
- **Flags**:
  - `--branch <name>`: Release from this branch instead of the current branch.
  - `--prerelease`: Mark the GitHub release as a pre-release. **Default is stable.**
  - `--dry-run`: Run all steps except git push and GitHub release creation.
  - `--skip-tests`: Skip the test step.

### Version handling

The fork has no fixed version-suffix convention; suffix choice is the user's call per
release. The command treats the version string as opaque:

- For `patch` / `minor` / `major`: increment the **base** version (the numeric `MAJOR.MINOR.PATCH` part), **strip any pre-release suffix**, and use the bumped base. Examples:
  - `1.1.4` + `patch` → `1.1.5`
  - `1.1.4-anything.3` + `patch` → `1.1.5` (suffix dropped — if the user wants a pre-release suffix on the bumped version, they must pass it explicitly)
  - `1.1.4` + `minor` → `1.2.0`
  - `1.1.4` + `major` → `2.0.0`
- For an explicit version string (e.g. `1.1.4-foo.1`, `2.0.0-rc.0`, `0.14.0`): use as-is.

The command does not impose a suffix scheme. If the user wants a specific suffix on a
bumped version (e.g. `1.1.5-light.0`), they pass the full version string explicitly.

## Working Directory

Monorepo. Release target is `packages/happy-cli`. Build / pack / test commands run from this subdirectory; git operations from the **monorepo root**.

- `git status --porcelain` shows paths relative to monorepo root (e.g., `packages/happy-cli/package.json`).
- `git add` must use the correct relative path from the repo root.
- `npm pack` is run inside `packages/happy-cli/` and emits the tarball into that directory.

## Release Steps

Execute sequentially. Stop immediately on any failure and report.

### Step 1: Pre-flight Checks

1. Verify `gh` CLI authenticated: `gh auth status`.
2. Determine the release branch:
   - If `--branch <name>` was passed, use that.
   - Otherwise, use the current branch from `git rev-parse --abbrev-ref HEAD`.
   - If the resolved branch differs from the current checkout, ask the user whether to `git checkout {branch}` first or abort.
3. Verify working tree clean: `git status --porcelain`. If dirty, list the changes and ask the user whether to proceed or abort. If proceeding, only the `package.json` version bump will be staged — unrelated changes remain unstaged.
4. Verify local `{branch}` is in sync with `origin/{branch}`:
   ```bash
   git rev-list --count origin/{branch}..{branch}   # 0 = no unpushed local commits
   git rev-list --count {branch}..origin/{branch}   # 0 = no unpulled remote commits
   ```
   If either is non-zero, ask the user to pull/push first before continuing.
5. Read `packages/happy-cli/package.json`:
   - Capture `name` (used for the tarball filename — do NOT hardcode).
   - Capture current `version`.
6. Determine target version per the rules in "Version handling" above. If the user passed `patch`/`minor`/`major`, compute the bump and confirm the resulting version string with them before proceeding.
7. Detect repo owner/name **strictly from `git remote get-url origin`** (parse SSH or HTTPS URL). Do NOT fall back to `package.json#repository` — in this fork that field still points to upstream, which routes the release to the wrong repo and surfaces as a misleading 404.
8. Resolve the prerelease flag:
   - Default: prerelease = false.
   - If `--prerelease` was passed: prerelease = true.
9. Check no GitHub release exists for this tag yet:
   ```bash
   gh release view "v{version}" --repo {owner}/{repo}
   ```
   If the release already exists, abort and instruct the user: "Either choose a different version, or delete the existing release with `gh release delete v{version} --repo {owner}/{repo}` before retrying."
10. Confirm with the user, showing the resolved values:
    ```
    Ready to release:
      Branch:     {branch}
      Version:    {version}
      Tag:        v{version}
      Repo:       {owner}/{repo}
      Tarball:    {name}-{version}.tgz
      Prerelease: {true|false}
    Proceed?
    ```

### Step 2: Version Bump

1. Update the `version` field in `packages/happy-cli/package.json` using the Edit tool.
2. Do NOT commit yet.

### Step 3: Build

```bash
cd packages/happy-cli
yarn build
```

If build fails, stop and report. Remind the user that `package.json` was modified — they may need to revert with `git checkout -- packages/happy-cli/package.json`.

### Step 4: Tests (unless --skip-tests)

```bash
yarn test
```

Compare the failure set against the documented baseline at `docs/plans/pre-existing-test-fails-2026-04-28.md` (and the more recent baseline at `/tmp/test-baseline.log` if present in this session). Known pre-existing fails should not block release. New failures are a stop signal — report regression and let the user re-run with `--skip-tests` only after manual verification.

### Step 5: Pack

```bash
npm pack
```

Produces `{name}-{version}.tgz` (where `{name}` is read from `package.json` — do NOT hardcode the name). Verify the file exists at `packages/happy-cli/{name}-{version}.tgz`. Capture its absolute path and report its size.

### Step 6: Git Commit & Tag

From the **monorepo root**:

```bash
git add packages/happy-cli/package.json
git commit -m "chore(release): happy-cli v{version}"
git tag "v{version}"
```

Use the exact version string. Tag format is `v{version}`. Only stage `packages/happy-cli/package.json` — do not stage unrelated changes.

### Step 7: Push (skip if --dry-run)

```bash
git push origin {branch}
git push origin "v{version}"
```

Push both the commit and the tag.

### Step 8: GitHub Release (skip if --dry-run)

Generate release notes by running:

```bash
node packages/happy-cli/.release-it.notes.js {version}
```

If the script fails (e.g. `claude` CLI is unavailable), fall back: read `git log --no-merges` since the previous tag matching `v*` on this branch (or, if there is no previous tag reachable from this branch, since the branch's divergence point with `origin/main` or `upstream/main` — pick a reasonable starting point) and write a concise changelog yourself, grouped by `feat:` / `fix:` / `chore:`.

Build the `gh release create` command. **You MUST pass `--repo {owner}/{repo}` explicitly** — `gh` would otherwise read `package.json#repository` (which points to upstream) and return HTTP 404 (misleadingly surfaced as a "workflow scope may be required" error).

```bash
gh release create "v{version}" "./packages/happy-cli/{name}-{version}.tgz" \
  --repo {owner}/{repo} \
  --title "v{version}" \
  --notes "{release_notes}" \
  --target {branch} \
  {prerelease_flag}
```

Where `{prerelease_flag}` is:
- `--prerelease` if `--prerelease` was passed (resolved value from Step 1.8 is `true`).
- empty (omit the flag entirely) by default.

### Step 9: Cleanup & Summary

1. Delete the local `.tgz` file at `packages/happy-cli/{name}-{version}.tgz`.
2. Print a summary:

```
Release v{version} published successfully!

Branch:     {branch}
Tag:        v{version}
Prerelease: {true|false}
Release:    https://github.com/{owner}/{repo}/releases/tag/v{version}

Install command:
  npm install -g https://github.com/{owner}/{repo}/releases/download/v{version}/{name}-{version}.tgz
```

## Dry Run Behavior

When `--dry-run` is specified:
- Steps 1-6 execute normally (pre-flight, version bump, build, test, pack, commit, tag).
- Steps 7-8 are SKIPPED (no push, no GitHub release).
- Step 9: Instead of cleanup, tell the user:
  - "Dry run complete. To undo: `git reset --soft HEAD~1 && git checkout -- packages/happy-cli/package.json && git tag -d v{version}`"
  - Show the `.tgz` path so they can inspect it.

## Error Recovery

- If any step fails after Step 2 (version field modified), warn the user that `package.json` has been modified and they may need to revert with `git checkout -- packages/happy-cli/package.json`.
- If a step fails after Step 6 (commit + tag created locally), the recovery command is `git reset --soft HEAD~1 && git tag -d v{version}` (then `git checkout -- packages/happy-cli/package.json` to revert the version bump).
- Never force-push or use destructive git operations.
- If the GitHub release already exists for this tag, report the conflict and suggest `gh release delete v{version} --repo {owner}/{repo}` if the user wants to retry.

## Why This Skill Differs From The `release-compat` Skill On `compat/pre-v3-clean`

The skill on the `compat/pre-v3-clean` branch is the historical release flow targeting the `happy-coder` package name. It remains in place for compat-line maintenance and is not affected by this skill.

This skill targets the active development line. Key differences:

| Aspect | compat skill | this skill |
|---|---|---|
| Package name | hardcoded `happy-coder` | dynamic, read from `package.json#name` |
| Tarball filename | `happy-coder-{v}.tgz` | `{name}-{v}.tgz` (computed) |
| Default branch | `main` (per old `requireBranch`) | current branch (overridable via `--branch`) |
| Prerelease flag | conditional (only when not `main`) | default-off, opt-in via `--prerelease` |
| Version semantics | imposed `0.13.0-compat.{N}` shape | opaque — user controls suffix |
| `--repo` requirement | required (same fork-routing bug) | required (same fork-routing bug) |
| `npm publish` | never called | never called |

Both lineages can coexist. Releases on the compat lineage continue to come out of `compat/pre-v3-clean`; releases on this lineage come out via this skill.
