---
description: "Build & push the happy-server Docker image to GHCR (linux/amd64, daily YYYYMMDD tag, overwrite-on-rebuild)"
argument-hint: "[--branch <name>] [--dry-run] [--allow-dirty] [--skip-tests] [--date YYYYMMDD]"
---

# Release Skill — happy-server Docker image (LightYear512/happy fork)

You are publishing the `happy-server` Docker image from this **fork**.
Images are pushed to **GitHub Container Registry (GHCR)** under the fork owner. The image tag is the build date `YYYYMMDD` — re-running on the same day **overwrites** the tag (Docker registry semantics: pushing the same tag replaces the previous manifest; previous image layers are eventually GC'd by GHCR).

The deployable reference is:

```
ghcr.io/lightyear512/happy-server:{YYYYMMDD}
```

There is **no `latest` tag** — every deploy must reference an explicit dated tag, so a rollback is just "pin yesterday's date". This is intentional: opaque `latest` rolls drift silently and bite oncall.

> ⚠️ **Apple Silicon note.** This skill builds **linux/amd64 only**. On an M-series Mac that means QEMU emulation under buildx — the build is 2–4× slower than native amd64 (typical wall time 8–20 min). Don't try to "speed it up" by dropping `--platform linux/amd64`; the resulting arm64 image won't run on the production amd64 hosts.

## Input

The user provides: `$ARGUMENTS`

Parse arguments:
- **Flags**:
  - `--branch <name>`: Build from this branch instead of the current branch.
  - `--dry-run`: Run pre-flight + tests + login + build + smoke, then **stop before pushing to GHCR**. The image is materialized into the local Docker daemon (via buildx `--load`) so you can `docker run` it locally to test. Use this for fast iteration — no registry round-trip, no overwrite of yesterday's good tag, no Docker push wall time. The most common test mode.
  - `--allow-dirty`: Skip the "working tree clean" / "branch synced with origin" checks. Use this in combination with `--dry-run` for local iteration off a dirty branch — the resulting image is **not reproducible from any committed SHA**, so never push it. Without `--dry-run`, this flag is still honored but you'll be warned that the dated tag points at code that doesn't exist anywhere on origin.
  - `--skip-tests`: Skip the `yarn workspace happy-server test` step.
  - `--date YYYYMMDD`: Override the date tag. Default is **today in the user's local timezone** (`date +%Y%m%d`). Use this only to reproduce a historical tag on purpose (e.g., rebuild yesterday's release with a hotfix patch).

### Test-loop usage

For local testing without round-tripping GHCR:

```
/release-server --dry-run --allow-dirty --skip-tests
```

This builds and loads the image into your local Docker daemon. Inspect it with `docker run --rm -p 3000:3000 ghcr.io/lightyear512/happy-server:{YYYYMMDD}` (you'll need the env vars and DB the server expects). Iterate as much as you want — nothing leaves your machine. When you're ready to publish, drop the flags and re-run.

There is no version-bump argument here — the server is not versioned via `package.json`. The tag is purely date-based.

## Working Directory

Monorepo. Build context is the **monorepo root** (the Dockerfile copies from multiple workspaces: `packages/happy-server`, `packages/happy-wire`, `patches/`, `scripts/`). The Dockerfile lives at `Dockerfile.server` in the repo root.

- All `docker` commands run from the **monorepo root**.
- `yarn workspace happy-server test` runs from anywhere (yarn resolves the workspace).
- Git operations from the monorepo root.

## Release Steps

Execute sequentially. Stop immediately on any failure and report.

### Step 1: Pre-flight Checks

1. Verify `gh` CLI authenticated: `gh auth status`. We use `gh auth token` to log Docker into GHCR if not already logged in.
2. Verify `docker` daemon reachable: `docker info >/dev/null 2>&1`. If not, abort with: "Start Docker Desktop (or your Docker daemon) and retry."
3. Verify `buildx` is available: `docker buildx version >/dev/null 2>&1`. Modern Docker Desktop ships it by default; if missing, abort with install guidance.
4. Ensure a usable buildx builder exists. The default `desktop-linux` builder on Docker Desktop is fine. If `docker buildx ls` shows no `*` (current) builder supporting `linux/amd64`, create one: `docker buildx create --use --name happy-builder`.
5. Determine the release branch:
   - If `--branch <name>` was passed, use that.
   - Otherwise, current branch from `git rev-parse --abbrev-ref HEAD`.
   - If the resolved branch differs from the checkout, ask the user whether to `git checkout {branch}` first or abort.
6. Verify working tree clean: `git status --porcelain`.
   - If clean: continue.
   - If dirty **and** `--allow-dirty` was passed: list the changes and print one warning: "⚠️ Building from dirty tree — image is not reproducible from any committed SHA. OK in `--dry-run`; do not push to GHCR." Continue.
   - If dirty **and** `--allow-dirty` was NOT passed: list the changes and abort with: "Working tree dirty. Pass `--allow-dirty` if you intend to test locally (combine with `--dry-run`), otherwise commit or stash and retry."
7. Verify local `{branch}` is in sync with `origin/{branch}`:
   ```bash
   git rev-list --count origin/{branch}..{branch}   # 0 = no unpushed local commits
   git rev-list --count {branch}..origin/{branch}   # 0 = no unpulled remote commits
   ```
   - If both zero: continue.
   - If non-zero **and** `--allow-dirty` was passed: print a warning ("Branch ahead/behind origin — image won't trace to a remote commit") and continue.
   - If non-zero **and** `--allow-dirty` was NOT passed: abort and ask the user to pull/push first. The image SHA must trace back to a remote commit, otherwise rollback context is lost.
8. Detect repo owner from `git remote get-url origin`. The fork is `LightYear512/happy`. Lower-case the owner for GHCR (`lightyear512`) — GHCR requires lower-case namespaces.
9. Compute the image tag:
   - If `--date YYYYMMDD` was passed, validate it (8 digits) and use it.
   - Otherwise, `date +%Y%m%d` (local time).
10. Compute the full image reference:
    ```
    IMAGE=ghcr.io/{owner-lc}/happy-server:{YYYYMMDD}
    ```
11. Capture the build commit (for OCI labels):
    ```bash
    GIT_SHA=$(git rev-parse HEAD)
    GIT_SHA_SHORT=$(git rev-parse --short HEAD)
    ```
12. Probe whether this tag already exists on GHCR (informational, NOT blocking — same-day overwrite is the documented behavior of this skill):
    ```bash
    gh api "/users/{owner}/packages/container/happy-server/versions" --jq \
      '.[] | select(.metadata.container.tags[]? == "{YYYYMMDD}") | .id' 2>/dev/null
    ```
    If a version comes back, mention to the user: "Tag `{YYYYMMDD}` already exists on GHCR — this build will overwrite it (the previous image will become an untagged version, GC'd by GHCR's retention policy)."
13. Confirm with the user, showing the resolved values:
    ```
    Ready to build {& push|locally only}:
      Branch:      {branch}
      Commit:      {GIT_SHA_SHORT}{ + dirty if --allow-dirty}
      Image:       {IMAGE}
      Platform:    linux/amd64
      Overwrite:   {yes|no}            (whether the dated tag already exists on GHCR)
      Dry run:     {true|false}        (skip push)
      Allow dirty: {true|false}        (skip clean-tree / sync checks)
    Proceed?
    ```

### Step 2: Tests (unless --skip-tests)

```bash
yarn workspace happy-server test
```

Run from the monorepo root. The test step uses vitest under `packages/happy-server/vitest.config.ts`. If tests fail, stop and report. The `--skip-tests` escape hatch exists for emergency rebuilds where you've already verified independently — don't skip casually, the server isn't covered by CI on every branch.

### Step 3: Docker Login to GHCR (skipped if --dry-run)

**Skipped if --dry-run** — `buildx --load` doesn't need registry auth, only `--push` does. Skip this entire step for local-only builds; saves a token round-trip and avoids requiring `write:packages` scope just to test.

Check `~/.docker/config.json` for an existing GHCR credential. If absent or expired, log in using the gh token:

```bash
gh auth token | docker login ghcr.io -u {owner-lc} --password-stdin
```

The token needs `write:packages` scope. If `gh auth token` returns a token without that scope, ask the user to run `gh auth refresh -h github.com -s write:packages` and retry. Detect this case by inspecting the docker login error — the symptom is `denied: permission_denied: write_package` on push, but it surfaces only at Step 5; better to validate up-front by checking scopes via `gh api user --jq .login` (any 200 means token works) and trusting docker login's success.

### Step 4: Build (linux/amd64)

From the monorepo root:

```bash
docker buildx build \
  --platform linux/amd64 \
  --file Dockerfile.server \
  --tag {IMAGE} \
  --label org.opencontainers.image.source=https://github.com/{owner}/happy \
  --label org.opencontainers.image.revision={GIT_SHA} \
  --label org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --progress=plain \
  --load \
  .
```

Notes:
- `--load` materializes the built image into the local Docker daemon so we can inspect / smoke test before pushing. For multi-platform builds `--load` is not supported — but we are single-platform here, so it's fine.
- `--progress=plain` produces line-buffered output. Useful when running under a long-lived task harness (no fancy TTY redraws to swallow).
- The Dockerfile is multi-stage (deps → builder → runner). Build cache hits dramatically depend on whether `package.json` / `yarn.lock` / `prisma/schema.prisma` changed; expect 2–4 min on warm cache and 12–20 min cold (under amd64 emulation on Apple Silicon).

If the build fails:
- **`ENOSPC` / no space left**: clean cache via `docker buildx prune -f` and retry. Don't `docker system prune -af` blindly — that nukes other users' images.
- **Yarn workspace resolution errors**: usually means a new package was added and the Dockerfile's `mkdir -p packages/...` and `COPY packages/.../package.json` lines need to be updated. Open `Dockerfile.server` and add the new package; commit before retrying (Step 1.6 will block dirty trees).

### Step 5: Smoke Check (local)

Before pushing, run a fast image-level sanity check:

```bash
# Image exists locally and has the expected platform
docker image inspect {IMAGE} --format '{{.Os}}/{{.Architecture}}'   # expect: linux/amd64
docker image inspect {IMAGE} --format '{{.Size}}'                    # log size in bytes for the summary

# CMD prints help / version cleanly (no startup crash before binding port).
# We do NOT actually start the server here (would need DB, env vars, secrets) — just exercise that the entrypoint resolves.
docker run --rm --platform linux/amd64 --entrypoint sh {IMAGE} -c \
  'node -e "console.log(require(\"/repo/packages/happy-server/package.json\").name)"'
# expect: happy-server
```

If either check fails, the image is broken — do not push. Report and stop.

### Step 6: Push (skipped if --dry-run)

**Skipped if --dry-run.** In dry-run mode, print the planned `docker push` command and the IMAGE reference, then proceed to Step 7.

In a real run:

```bash
docker push {IMAGE}
```

Capture the digest from the push output (line `digest: sha256:...`) — we report it in the summary.

### Step 7: Verify Pushed Image (skipped if --dry-run)

```bash
gh api "/users/{owner}/packages/container/happy-server/versions" \
  --jq '.[] | select(.metadata.container.tags[]? == "{YYYYMMDD}") | {id, name, created_at, tags: .metadata.container.tags}'
```

Confirm the dated tag is present and the `created_at` matches this run (within a minute). If the tag is missing despite a successful push, suspect a token-scope issue and re-check `gh auth status` / docker login.

### Step 8: Cleanup & Summary

1. Optionally remove the local image if the user wants disk back: ask "Delete local image `{IMAGE}` to reclaim ~{Size MB}? (y/N)" — default no, since keeping it lets a follow-up `docker run` proceed without re-pulling.
2. Print summary:

```
Server image published successfully!

Branch:   {branch}
Commit:   {GIT_SHA_SHORT}
Image:    {IMAGE}
Digest:   sha256:{first-12-of-digest}…
Platform: linux/amd64
Size:     {Size MB} MB
Pushed:   {ISO timestamp}
Pull:
  docker pull {IMAGE}

Deploy reference (k8s manifest snippet):
  image: {IMAGE}
  imagePullPolicy: IfNotPresent
```

If `--dry-run`, replace the "Pushed" line with `Dry run — push skipped.` and adjust accordingly.

## Dry Run Behavior

`--dry-run` MUST produce zero registry side effects: no GHCR push, no GHCR overwrite. Local Docker daemon state DOES change (the image is loaded locally via `--load`) — that's by design so the smoke check in Step 5 can run, and so you can `docker run` the image to actually test the server.

- Steps 1–2 execute normally (pre-flight, tests).
- Step 3 SKIPPED — no need to log into GHCR for a local-only build.
- Steps 4–5 execute normally (build, smoke).
- Step 6 SKIPPED — print the planned push command only.
- Step 7 SKIPPED — nothing to verify on GHCR.
- Step 8 runs, with the summary's "Pushed" line replaced by a dry-run notice.

After dry-run, the local image `{IMAGE}` exists in your Docker daemon. Remove it with `docker image rm {IMAGE}` if you don't want it sitting there.

## Allow-Dirty Behavior

`--allow-dirty` only loosens the pre-flight reproducibility checks (Step 1.6 working tree, Step 1.7 branch sync). It does NOT affect what gets built — `docker buildx` always uses the current working tree, regardless of git state.

- With `--allow-dirty` alone (no `--dry-run`): a warning is printed before the GHCR push that the dated tag will point at code that doesn't exist on origin. **Strongly discouraged in real releases** — rollbacks need a SHA to come home to.
- With `--allow-dirty --dry-run` (the standard test loop): no push, no warning fatigue, just build and load locally. This is the intended pairing.

In short: `--allow-dirty` opens a door; `--dry-run` makes the door safe to open.

## Error Recovery

- **Pre-flight failure**: nothing has been touched; fix the prerequisite and retry.
- **Test failure**: nothing has been touched; fix the regression. Do not use `--skip-tests` to paper over real failures.
- **Build failure**: no GHCR side effects; local buildx cache may have grown. `docker buildx prune -f` to reclaim.
- **Push failure mid-upload**: GHCR is layer-based — a failed push leaves partial layers but no new tag. Just retry `docker push {IMAGE}`.
- **Overwrote the wrong tag**: the previous image is **not** lost immediately — it becomes an untagged version under the same package. Rollback by re-tagging it: find the prior digest via `gh api /users/{owner}/packages/container/happy-server/versions`, then `docker pull ghcr.io/{owner-lc}/happy-server@sha256:{digest}` + `docker tag` + `docker push` with the correct date. GHCR retains untagged versions per its retention policy (default: kept until you delete or the policy expires them).
- Never use `docker push --force` (it doesn't exist in modern Docker; tag overwrite is the default behavior). Never `docker rmi` the remote image directly through the CLI; use `gh api -X DELETE` only if you genuinely want to remove a tagged version, and confirm with the user first.

## Why This Skill Differs From `release-cli` / `release-app`

| Aspect | `/release-cli` | `/release-app` | `/release-server` |
|---|---|---|---|
| Artifact | `.tgz` tarball | `.apk` | OCI container image |
| Distribution channel | GitHub Releases | GitHub Releases | GHCR (container registry) |
| Versioning | semver from `package.json` | `appVersion-suffix` from `app.config.js` | date-based `YYYYMMDD`, overwrite-on-rerun |
| Local commit/tag | yes | no (gh creates it) | **no** — date tag isn't in git |
| Build engine | local `yarn build` + `npm pack` | EAS cloud build | local `docker buildx build` |
| Multi-arch | n/a (JS) | arm64-v8a (EAS) | linux/amd64 only |
| Tests | `yarn test` | none (EAS internal) | `yarn workspace happy-server test` |
| Pre-flight strictness | clean tree + sync | clean tree + sync | clean tree + sync |
| Push/publish | `gh release create` | `gh release create` | `docker push` to GHCR |
| Same-version retry | blocked (must bump or delete) | blocked (must bump suffix) | **allowed (overwrite is the model)** |

The "same-day overwrite" model is intentional: the server is a long-running service, not a distributed artifact. The dated tag is a snapshot pointer, not a release identity. If you need a stronger identity for a specific deploy (e.g. for compliance or post-mortem), reference the digest instead of the tag — the digest is immutable even when the tag is overwritten.

## Notes for the Skill Author / Future Self

- If GHCR push starts erroring with `denied: installation not allowed to Create organization package` on a first-time push to a fresh package, it usually means GHCR hasn't auto-created the package under the user namespace yet. Workaround: manually push once with `docker push` while logged in as the org owner; subsequent pushes inherit the package's visibility setting (default: private). Make the package public via the GitHub UI under the user's Packages tab if you want unauthenticated pulls.
- Apple Silicon developers may want to keep a long-running buildx builder warm to avoid re-bootstrapping QEMU each time: `docker buildx create --use --name happy-builder --bootstrap`. Re-using the same builder name across runs preserves the buildkit layer cache between invocations, which is the single biggest wall-clock win on M-series.
- If the Dockerfile gains a new workspace dependency (e.g. a future `packages/happy-foo`), update the `mkdir -p packages/happy-app packages/happy-server packages/happy-cli packages/happy-wire` line and add a `COPY packages/happy-foo/package.json packages/happy-foo/` block in stage 1. This skill does not auto-detect new workspaces — by design, since stage-1 layout decisions affect cache invalidation and should be human-reviewed.
- The `--platform linux/amd64` flag is non-negotiable for production. If you ever introduce a separate dev-only profile (e.g. native arm64 for local kind clusters), put it behind an explicit `--platform-arm64` flag in this skill rather than auto-selecting the host platform — silent platform mismatches between dev and prod images are a classic oncall trap.
