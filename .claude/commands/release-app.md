---
description: "Build Android APK via EAS and publish a GitHub Release (fork, no Play Store)"
argument-hint: "<tag-suffix> [--profile preview|production] [--branch <name>] [--dry-run]"
---

# Release Skill — happy-app Android APK (LightYear512/happy fork)

You are performing a release of the `happy-app` Android APK from this **fork**.
Since this is a fork (and `production` bundle id `com.ex3ndr.happy` is owned by upstream), we publish via **GitHub Releases + APK file**, NOT Play Store.

Users install with:

```bash
adb install <apk-from-github-release>
# or download on phone and tap to install (allow unknown sources)
```

> ⚠️ **DO NOT use `yarn release`** in `packages/happy-app/`. That script invokes EAS submit flows that target Apple/Play stores; on this fork the iOS submit goes to `steve@bulkovo.com`'s Apple account (upstream), and Android Play submit is impossible because the production bundle id is upstream-owned. This skill orchestrates `eas build` (cloud) + `gh release create` manually so no store submission ever happens.

## Input

The user provides: `$ARGUMENTS`

Parse arguments:
- **`<tag-suffix>`** (required): The suffix appended to the app version. Examples: `laya.preview.0`, `laya.preview.1`. The full tag is computed as `v{appVersion}-{tag-suffix}`. If omitted, ask the user.
- **Flags**:
  - `--profile <name>`: EAS build profile. Defaults to `preview` (APK, internal distribution). `production` is allowed but typically unusable on this fork (see Why below).
  - `--branch <name>`: Build from this branch instead of current. The branch must be pushed to origin first — EAS builds whatever EAS sees in the upload, but the GitHub release `--target` must point at a remote ref.
  - `--dry-run`: Trigger EAS build, monitor to completion, download APK, but skip the `gh release create` step. Useful for verifying a build without making it public.

### Tag computation

App version comes from `packages/happy-app/app.config.js` (the literal `version: "1.7.0"` field — read it; do **not** hardcode). versionCode (the integer Android build number) is **EAS-remote-managed** (autoIncrement) — you do not bump it locally.

Examples:
- `app.config.js` version `1.7.0` + suffix `laya.preview.0` → tag `v1.7.0-laya.preview.0`
- `app.config.js` version `1.7.1` + suffix `laya.preview.2` → tag `v1.7.1-laya.preview.2`

To bump the app version itself, edit `packages/happy-app/app.config.js#expo.version` and commit/push **before** running this skill. This skill does not modify `app.config.js`.

## Working Directory

Monorepo. Build target is `packages/happy-app`. EAS commands run from this subdirectory; git operations from the **monorepo root**.

- `eas` and `gh` must both be authenticated (this skill verifies in pre-flight).
- The EAS project is linked at `packages/happy-app/app.config.js` → `extra.eas.projectId`.

## Release Steps

Execute sequentially. Stop immediately on any failure and report.

### Step 1: Pre-flight Checks

1. Verify `gh` CLI authenticated to a fork-owning account:
   ```bash
   gh auth status
   ```
2. Verify `eas` CLI authenticated:
   ```bash
   cd packages/happy-app && eas whoami
   ```
   On the LightYear512 fork this should print `lightyear512`.
3. Determine the release branch:
   - If `--branch <name>` was passed, use that.
   - Otherwise, current branch from `git rev-parse --abbrev-ref HEAD`.
   - If the resolved branch differs from the checkout, ask the user whether to `git checkout {branch}` first or abort.
4. Verify local `{branch}` is in sync with `origin/{branch}`:
   ```bash
   git rev-list --count origin/{branch}..{branch}   # 0 = no unpushed local commits
   git rev-list --count {branch}..origin/{branch}   # 0 = no unpulled remote commits
   ```
   If either is non-zero, ask the user to pull/push first. EAS uploads the local working tree (a 200+MB tarball), so untracked or uncommitted state would also ship — confirm any dirty state before continuing.
5. Read app version from `packages/happy-app/app.config.js`:
   - Capture `expo.version` (e.g. `1.7.0`).
6. Compute target tag: `v{appVersion}-{tag-suffix}`. Confirm with the user.
7. Detect repo owner/name **strictly from `git remote get-url origin`**. Do NOT fall back to `package.json#repository` — like in `release-cli`, that field still points to upstream and routes the release to the wrong repo (HTTP 404).
8. Resolve profile:
   - Default: `preview`.
   - If `--profile production`: warn the user that the production bundle id is upstream-owned (`com.ex3ndr.happy`); APK can build but cannot be installed alongside upstream's Play Store install without uninstalling that first.
9. Verify the EAS profile pins Node ≥22:
   ```bash
   jq -r ".build[\"<profile>\"].node // \"unset\"" packages/happy-app/eas.json
   ```
   This must NOT be `unset` and must be `>=22.19.0`. If unset, abort with: "EAS workers default to Node 20.19.4, but the monorepo includes happy-cli's `undici@^8.1.0` which requires Node ≥22.19. Add `\"node\": \"22.19.0\"` to the `<profile>` profile in `packages/happy-app/eas.json` and commit before retrying."
10. Check no GitHub release exists for this tag yet:
    ```bash
    gh release view "v{appVersion}-{tag-suffix}" --repo {owner}/{repo}
    ```
    If the release exists, abort with: "Either choose a different tag-suffix, or delete the existing release with `gh release delete v{tag} --repo {owner}/{repo}` before retrying."
11. Confirm with the user, showing the resolved values:
    ```
    Ready to release Android APK:
      Branch:     {branch}
      Profile:    {profile}
      App ver:    {appVersion}
      Tag:        v{appVersion}-{tag-suffix}
      Repo:       {owner}/{repo}
      Bundle id:  com.slopus.happy.{profile} (or com.ex3ndr.happy for production)
    Proceed?
    ```

### Step 2: Trigger EAS Build (background)

From `packages/happy-app/`:

```bash
APP_ENV={profile} eas build --profile {profile} --platform android --no-wait --non-interactive
```

Run this with `run_in_background: true` and a long timeout (the upload is the slow part — typically 2-13 minutes depending on EAS layer cache). Wait for the background task notification.

When the task completes, parse the output for the build URL line:
```
See logs: https://expo.dev/accounts/.../builds/<BUILD_ID>
```

Extract `<BUILD_ID>` (a UUID).

If the trigger command exits non-zero, fail and report the EAS error verbatim.

### Step 3: Monitor Build Status

Mount a `Monitor` task that polls `eas build:view <BUILD_ID> --json` every 60 seconds, emitting an event each time the status transitions, and exiting on a terminal status.

**Robust parser pattern** — write the JSON to a temp file, then `grep` the `"status":` line. Do NOT pipe through `sed -n '/^{/,/^}/p'` — EAS CLI's stdout interleaves spinner lines (`- Fetching the build…` / `✔ Found a matching build...`) before the JSON, which break the range match in some shells.

```bash
cd packages/happy-app && BID=<BUILD_ID>; OUT=/tmp/eas-monitor-$BID.json; prev=""
while true; do
  eas build:view "$BID" --json >"$OUT" 2>/dev/null
  s=$(grep -E '^\s*"status":' "$OUT" | head -1 | sed -E 's/.*"status":[[:space:]]*"([^"]+)".*/\1/')
  [ -z "$s" ] && s="UNKNOWN"
  if [ "$s" != "$prev" ]; then echo "[$(date +%H:%M:%S)] status=$s"; prev=$s; fi
  case "$s" in
    FINISHED)
      url=$(jq -r '.artifacts.applicationArchiveUrl // .artifacts.buildArtifactsUrl // "N/A"' "$OUT")
      echo "BUILD FINISHED — APK URL: $url"
      break ;;
    ERRORED|CANCELED)
      emsg=$(jq -r '.error.message // "no error message"' "$OUT")
      echo "BUILD $s — $emsg"
      break ;;
  esac
  sleep 60
done
```

Use `Monitor` with `timeout_ms: 3600000` (60 min ceiling). Typical preview build: 15-30 minutes. Do NOT poll manually — wait for monitor events.

If the build ERRORED, download and decompress the EAS log to find the root cause:
```bash
curl -sS "$(jq -r '.logFiles[0]' /tmp/eas-monitor-$BID.json)" -o /tmp/log.br
node -e "process.stdout.write(require('zlib').brotliDecompressSync(require('fs').readFileSync('/tmp/log.br')))" > /tmp/eas.log
grep -E '"level":(40|50)|error|fail' /tmp/eas.log | tail -30
```

Note: EAS log files are **brotli-compressed** (not gzip). `gunzip` will fail; use `zlib.brotliDecompressSync` via Node, or install `brotli` CLI.

Common ERRORED root causes (known to this fork):
- **Engine "node" incompatible (<22.19.0)**: `undici@^8.1.0` from `happy-cli` requires Node ≥22.19. Fix: pin `"node": "22.19.0"` on the EAS profile in `eas.json`. Step 1.9 catches this pre-flight.

### Step 4: Download APK

```bash
URL=$(jq -r '.artifacts.applicationArchiveUrl' /tmp/eas-monitor-$BID.json)
APK=/tmp/happy-app-{appVersion}-{tag-suffix}.apk
curl -sL -o "$APK" "$URL"
file "$APK" | grep -q "Zip archive" || { echo "APK is not a valid ZIP"; exit 1; }
shasum -a 256 "$APK"
ls -lh "$APK"
```

Verify the file is a ZIP archive (APKs are ZIPs starting with `PK\x03\x04`). Capture the SHA256 for the release notes.

### Step 5: Write Release Notes

Create `/tmp/app-release-notes-{appVersion}-{tag-suffix}.md` with build metadata, install instructions, known limits, and a link to the paired `happy-cli` release if applicable. Template:

```markdown
# Happy App v{appVersion} ({tag-suffix})

Android APK release from the `LightYear512/happy` fork ({branch} line). Built via EAS {profile} profile; **internal preview, not Play Store**.

## Build metadata

| Field | Value |
|---|---|
| App version | {appVersion} |
| Version code | {versionCode from build JSON} |
| Build profile | {profile} |
| Channel | {channel from build JSON} |
| Bundle id | {bundleId from app.config.js} |
| Runtime version | {runtimeVersion from build JSON} |
| Architecture | arm64-v8a only |
| Build commit | {gitCommitHash} |
| Build job | {logsUrl} |
| SHA256 | {sha256} |

## Install

```bash
adb install happy-app-{appVersion}-{tag-suffix}.apk
```

Or download on phone and tap (allow "install from unknown sources").

## Notes / limits

- Bundle id is `com.slopus.happy.{profile}` (upstream-owned). Replaces any upstream Happy {profile} install.
- Built only for `arm64-v8a`. Older 32-bit ARM devices won't install.
- Preview profile build — not for store distribution.

## Related

- Latest happy-cli release: <link if present, otherwise omit this section>
```

### Step 6: Create GitHub Release (skipped if --dry-run)

**Skipped if --dry-run.** In dry-run, only print the planned tag, the APK path, and the notes file path; don't touch GitHub.

In a real run, from the **monorepo root**:

```bash
gh release create "v{appVersion}-{tag-suffix}" "$APK" \
  --repo {owner}/{repo} \
  --title "happy-app v{appVersion}-{tag-suffix} (Android {profile})" \
  --notes-file /tmp/app-release-notes-{appVersion}-{tag-suffix}.md \
  --target {branch} \
  --prerelease
```

Always `--prerelease` for `preview`-profile builds. For `production`-profile (if ever used on this fork), `--prerelease` may be dropped, but flag this as unusual and confirm with the user.

**You MUST pass `--repo {owner}/{repo}` explicitly** — `gh` would otherwise read `package.json#repository` (still pointing to upstream `slopus/happy`) and 404.

The APK upload is the slow step (107MB+, ~30-90s on a stable connection). Use a generous timeout (15+ min) on the Bash call to absorb network jitter. If the upload aborts mid-way (`unexpected EOF`), GitHub may leave a `draft` release behind — `gh release list` to check, then `gh release delete v{tag} --yes` to clean up before retrying.

### Step 7: Cleanup & Summary

1. Delete the local APK and notes file:
   ```bash
   rm /tmp/happy-app-{appVersion}-{tag-suffix}.apk /tmp/app-release-notes-{appVersion}-{tag-suffix}.md /tmp/eas-monitor-$BID.json
   ```
2. Print summary:

```
Release v{appVersion}-{tag-suffix} published successfully!

Branch:     {branch}
Tag:        v{appVersion}-{tag-suffix}
Profile:    {profile}
APK size:   {size}
SHA256:     {sha256}
Release:    https://github.com/{owner}/{repo}/releases/tag/v{appVersion}-{tag-suffix}

Direct APK:
  https://github.com/{owner}/{repo}/releases/download/v{appVersion}-{tag-suffix}/happy-app-{appVersion}-{tag-suffix}.apk
```

## Dry Run Behavior

`--dry-run` produces zero git/GitHub side effects. EAS-side state DOES change: a build job is queued, EAS quota is consumed, and `versionCode` is auto-incremented on the EAS server. There is no way to dry-run the EAS build itself short of skipping it, which would defeat the verification value.

- Steps 1-5 execute normally (pre-flight, trigger, monitor, download, write notes).
- Step 6 is SKIPPED — print the planned tag, APK path, notes path.
- Step 7: delete the APK and notes file from `/tmp` (or keep, at user's option).

After dry-run, the only persistent artifacts are: (a) the EAS build record on `expo.dev`, (b) the incremented versionCode on the EAS server. Both are inherent to running `eas build` and cannot be undone.

## Error Recovery

- **Pre-flight failure**: nothing has been touched; just fix the prerequisite and retry.
- **EAS build failure**: cloud-side; no local state changed. Inspect log via the brotli decompression recipe in Step 3 and fix root cause.
- **APK download failure**: re-run Step 4. The signed S3 URL embedded in `applicationArchiveUrl` expires in 15 minutes — if you wait too long, re-fetch the build via `eas build:view` to get a fresh URL.
- **`gh release create` failure mid-upload**: GitHub may leave a `draft` release. `gh release list --repo {owner}/{repo}` to check; `gh release delete v{tag} --repo {owner}/{repo} --yes` to clean up. The git tag itself is **not** affected by `gh release delete` (gh only removes the release object).
- Never force-push or use destructive git operations.

## Why This Skill Differs From `release-cli`

| Aspect | `/release-cli` | `/release-app` |
|---|---|---|
| Build engine | local `yarn build` + `npm pack` | EAS cloud build (10-30 min) |
| Asset | `.tgz` tarball | `.apk` |
| Version source | `packages/happy-cli/package.json#version` (locally bumped) | `packages/happy-app/app.config.js#expo.version` (locally bumped); versionCode managed remotely by EAS |
| Local commit/tag created | yes (real run) | **no** — the tag is created by `gh release create --target` in Step 6, no local commit |
| Test step | yarn test | none (EAS runs its own type/install checks) |
| Dry-run side effects | zero (after the 0276c5865 fix) | EAS build record + versionCode bump persist (cannot be undone) |
| `--repo` requirement | required (fork-routing bug) | required (same bug) |
| `npm publish` / Play submit | never called | never called |

## Notes for the Skill Author / Future Self

- Pre-flight Step 1.9 (Node ≥22 check) was added after a real failure: the first preview build of `1.7.0-laya.preview.0` on commit `5c6343eb4` failed in `INSTALL_DEPENDENCIES` because the EAS worker's default Node 20.19.4 rejected `undici@8.1.0`. Fix lives at commit `4e5996c5` (pinned `"node": "22.19.0"` on all 5 non-`simulator-test` profiles). Keep that pre-flight check until/unless `undici`'s engine requirement softens or `happy-cli` drops the dependency.
- The Monitor parser was rewritten to use `grep '^\s*"status":'` after a flaky session where `sed -n '/^{/,/^}/p'` returned empty under the harness shell, leaving the monitor stuck reporting `UNKNOWN`. The "write to file, then grep" pattern is more robust because it is independent of subshell stdout buffering.
- EAS log files served from `storage.googleapis.com/eas-workflows-production/...` are **brotli-compressed**. `curl --compressed` fails (libcurl typically lacks brotli). Use Node's `zlib.brotliDecompressSync`.
- Bundle ids on this fork are still upstream-owned — the only realistic distribution channel is GitHub Releases + manual install. If you ever migrate to a fork-owned bundle id (`com.lightyear512.happy.*`), the `submit` config in `eas.json` will need a Google Play Console account before that path is usable.
