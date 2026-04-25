---
description: "Build, pack, and publish a GitHub Release with installable tarball"
argument-hint: "[patch|minor|major|<version>] [--dry-run] [--skip-tests]"
---

# Release Skill — happy-cli (fork, no npm registry)

You are performing a release of the `happy-coder` CLI package. Since this is a fork, we publish via **GitHub Releases + tarball** instead of npm registry. Users install with:

```bash
npm install -g <tarball-url-from-github-release>
```

## Input

The user provides: `$ARGUMENTS`

Parse the arguments:
- **Version bump**: `patch`, `minor`, `major`, or an explicit version like `0.15.0` or `0.14.1-beta.1`. If omitted, ask the user.
  - For pre-release versions (e.g., `0.14.0-compat.3`), `patch`/`minor`/`major` operate on the **base version** and drop the pre-release suffix. So `0.14.0-compat.3` + `patch` → `0.14.1`. To increment the pre-release number instead, the user must pass an explicit version like `0.14.0-compat.4`.
- **Flags**:
  - `--dry-run`: Run all steps except git push and GitHub release creation. Show what would happen.
  - `--skip-tests`: Skip the test step.

## Working Directory

This project is a monorepo. The release target is `packages/happy-cli`. All build/pack/test commands run from this subdirectory, but git operations run from the **monorepo root**. Be aware:
- `git status --porcelain` shows paths relative to monorepo root (e.g., `packages/happy-cli/package.json`)
- `git add` must use the correct relative path from the repo root

## Release Steps

Execute these steps **sequentially**. Stop immediately on any failure and report the error.

### Step 1: Pre-flight Checks

1. Verify `gh` CLI is available and authenticated (`gh auth status`)
2. Verify working directory is clean (`git status --porcelain`). If dirty, list the changes and ask the user whether to proceed or abort. If proceeding, only the `package.json` version bump will be committed — unrelated changes remain unstaged.
3. Read the current version from `package.json`
4. Determine the target version based on user input:
   - `patch`: increment patch (e.g., `0.14.0` → `0.14.1`)
   - `minor`: increment minor (e.g., `0.14.0` → `0.15.0`)
   - `major`: increment major (e.g., `0.14.0` → `1.0.0`)
   - Explicit version: use as-is
5. Note the current branch name. This release does NOT require `main` branch — we may release from feature/compat branches.
6. Detect the GitHub repo owner/name **from `git remote get-url origin` only** (parse SSH or HTTPS URL). Do NOT fall back to `package.json#repository` — in this fork, that field still points to upstream `slopus/happy-cli`, which would route the release to the wrong repo and cause a 404.
7. Confirm with the user: "Ready to release **v{version}** from branch **{branch}**. Proceed?"

### Step 2: Version Bump

1. Update the `version` field in `package.json` using the Edit tool
2. Do NOT commit yet

### Step 3: Build

Run in the `packages/happy-cli` directory:

```bash
yarn build
```

If the build fails, stop and report.

### Step 4: Tests (unless --skip-tests)

```bash
yarn test
```

If tests fail, stop and report. The user can re-run with `--skip-tests` to skip.

### Step 5: Pack

```bash
npm pack
```

This produces a file like `happy-coder-{version}.tgz` in the current directory. Verify the file exists and report its size.

### Step 6: Git Commit & Tag

Run from the **monorepo root**:

```bash
git add packages/happy-cli/package.json
git commit -m "chore: release v{version}"
git tag "v{version}"
```

Use the exact version string. Tag format is `v{version}` (e.g., `v0.15.0`). Only stage `package.json` — do not stage unrelated changes.

### Step 7: Push (skip if --dry-run)

```bash
git push origin {branch}
git push origin "v{version}"
```

Push both the commit and the tag.

### Step 8: GitHub Release (skip if --dry-run)

Generate release notes by running the existing script:

```bash
node .release-it.notes.js {version}
```

If the script fails (e.g., `claude` CLI not available), fall back to generating release notes yourself by reading `git log` since the last tag and writing a concise changelog.

Create the GitHub release with the tarball attached. **You MUST pass `--repo {owner}/{repo}` explicitly** — otherwise `gh` reads `package.json#repository` (which points to upstream `slopus/happy-cli`) and the API returns HTTP 404, surfaced misleadingly as `"workflow" scope may be required`. Token scopes are fine; the error is a routing bug.

```bash
gh release create "v{version}" ./happy-coder-{version}.tgz \
  --repo {owner}/{repo} \
  --title "v{version}" \
  --notes "{release_notes}" \
  --target {branch}
```

If the branch is not `main`, add `--prerelease` flag automatically.

### Step 9: Cleanup & Summary

1. Delete the local `.tgz` file
2. Print a summary:

```
Release v{version} published successfully!

Branch:  {branch}
Tag:     v{version}
Release: https://github.com/{owner}/{repo}/releases/tag/v{version}

Install command:
  npm install -g https://github.com/{owner}/{repo}/releases/download/v{version}/happy-coder-{version}.tgz
```

## Dry Run Behavior

When `--dry-run` is specified:
- Steps 1-6 execute normally (version bump, build, test, pack, commit, tag)
- Steps 7-8 are SKIPPED (no push, no GitHub release)
- Step 9: Instead of cleanup, tell the user:
  - "Dry run complete. To undo: `git reset HEAD~1 && git tag -d v{version}`"
  - Show the .tgz path so they can inspect it

## Error Recovery

- If any step fails after the version bump (Step 2), warn the user that `package.json` has been modified and they may need to revert.
- Never force-push or use destructive git operations.
- If the GitHub release already exists for this tag, report the conflict and suggest `gh release delete v{version}` if the user wants to retry.
