# Release acceptance

`Release acceptance` is an opt-in `workflow_dispatch` gate. It does not publish
packages, push Git refs, create releases, or move an installer channel.

## Exact inputs

The dispatch must provide:

- `revo_revision`: the full SHA of the checked-out Revo revision. The workflow
  requires it to equal `github.sha`.
- `tui_repository`: currently allowlisted to `revisium/revo-tui`.
- `tui_revision`: the full SHA used by the TUI producer workflow.
- `tui_run_id`, `tui_run_attempt`: the exact successful producer run and
  attempt. The first workflow version accepts attempt `1` only.
- `tui_artifact_id`: the exact `revo-tui-verified-package` artifact ID.
- `tui_tarball_sha256`: the SHA256 of the tarball inside that artifact.
- `channel`: `alpha` or `stable`.

The channel must match the checked-out Revo version before any producer
artifact is downloaded: `stable` requires a non-prerelease SemVer and `alpha`
requires a prerelease SemVer. The current `0.0.0` snapshot is therefore tested
with `stable`; alpha acceptance remains `NOT RUN` until the release-train
prerelease snapshot exists. This workflow does not run the release train or
rewrite package versions.

The prepare job queries the GitHub API and rejects a run unless its workflow
path, head SHA, attempt, conclusion, and all four native jobs plus `assemble`
and `verify-handoff` match. It checks the artifact ID, name, producer run,
expiry, GitHub digest, downloaded ZIP digest, package manifest, four native
targets, source revision, and the requested tarball SHA. The ZIP handoff is
restricted to the manifest and one `.tgz` file, with bounded archive and entry
sizes, regular-file-only entries, and streaming extraction. No latest-run or
name-only fallback is permitted.

## Staging dependency boundary

The production Revo `package.json`, `pnpm-lock.yaml`, and
`pnpm-workspace.yaml` are not modified. The prepare job creates a private
copy, replaces only the direct `@revisium/revo-tui` dependency with:

```text
https://127.0.0.1:8443/tui/<tarball-sha256>/<tarball-name>?sha256=<tarball-sha256>
```

It regenerates a staging lock with pnpm 12.5.1, checks the exact URL and SRI,
rejects lock drift outside the TUI blocks, and runs a fresh frozen install.
The staging source is an explicit build-input inventory: hosted runs copy the
current bytes of tracked build inputs at the checked-out revision; local
snapshots without Git must pass a JSON inventory with `--source-files` that
lists every current production `src/**/*.ts` file. The allowlist excludes
tests, workflow files, nested checkouts, local evidence, and caches. It is not
a secret scanner: files explicitly admitted by the build-input policy must
still be reviewed for sensitive content. The receipt records SHA256 for each
copied source file before the TUI override.

Snapshotting assumes a trusted checkout or prepared copy that remains
unchanged during the operation, and an isolated output parent that already
exists and is not writable by untrusted users. The output directory must be
absent or an owned, empty `0700` directory; created subdirectories are `0700`
and files are `0600`. Detected changes fail preparation. Failed writes may
leave a private partial output for diagnosis; the helper does not recursively
delete it. Path identity checks reduce common replacement windows, but this is
not an atomic filesystem snapshot or protection against a concurrent
same-UID/root process, mount changes, or filesystem-specific behavior. Staging
is intentionally modified later when the TUI dependency override is applied.
The loopback server has strict HTTPS, exact allowlisted routes, no redirects,
no proxy/fallback, and bounded diagnostic logs. The generated bundle is
checked with its own `SHA256SUMS` before it is uploaded as one immutable
acceptance artifact.

The acceptance jobs create a short-lived private CA and a separate localhost
leaf certificate. Only the CA is added to the runner trust store; the private
key and certificate are kept outside the handoff. The CA is removed in an
always-run cleanup step. The staging exception does not disable pnpm trust
policies: the production workspace is copied byte-for-byte and no
`trustPolicyExclude` is added.

The pnpm 12.5.1 C0 before/after lockfiles under
`test/fixtures/acceptance-lockfile/` are unmodified byte-for-byte experiment
evidence, not formatter-managed source. Their hashes are pinned by the
provenance file and verified by the lockfile validation test. Regenerate them
only from a new reproducible C0 experiment; do not reformat them in place.

## Consumer acceptance

The four consumer jobs (`ubuntu-22.04`, `ubuntu-22.04-arm`,
`macos-15-intel`, and `macos-15`) download the same acceptance artifact and
verify both the outer handoff inventory and the bundle inventory. The TUI
tarball keeps the producer manifest filename; the consumer performs a strict
HTTPS GET of the exact URL from the bundle dependency and checks its SHA256
before running the installer. It also rechecks the Revo revision/channel and
the exact TUI producer run, attempt, artifact, revision, version, and digest
from the handoff metadata. As the ordinary hosted runner user they run the
actual:

```sh
cat install.sh | sh
```

The checks cover installed version/doctor output, Admin HTML, GraphQL health,
server start/status/stop/restart, standalone TUI connected/no-TTY/recovery/
contention PTY behavior, the `revo tui` wrapper, and final server cleanup.
Each consumer job pins `REVO_CHANNEL`, loopback host, and port at job scope.
Install root, data root, and `HOME` are set at step scope only for lifecycle,
TUI, and cleanup steps because GitHub's `runner.temp` context is not available
in `jobs.<job_id>.env`. The three steps use the same effective paths. HTTP
checks use the configured origin rather than parsing human-readable `server
start` output, which may only report that the installer-started server is
already running.
PTY evidence is bounded and private; timeout or cleanup failure fails the job.

The TUI remains POSIX-only. Windows Revo support is outside this acceptance
workflow and is tracked separately.

## Local Linux harness

The harness is a manual, opt-in runtime check rather than an automated TUI
test suite. It owns a new private evidence directory and requires at least one
non-empty readiness marker:

```sh
python3 scripts/acceptance/pty-harness.py \
  --executable /absolute/path/to/revo-tui.js \
  --node-executable /absolute/path/to/node \
  --api-url http://127.0.0.1:3210/graphql \
  --data-dir /absolute/path/to/tui-data \
  --evidence-dir /absolute/path/to/new-evidence \
  --scenario connected \
  --expect initialized
```

Use `recovery` and `contention` as separate invocations. The harness verifies
no-TTY rejection, bounded nonblocking PTY reads, process-group cleanup,
cross-process storage locking, and recovery after `SIGKILL`.

Hosted acceptance is not proven until the workflow is actually dispatched and
all four consumer jobs pass. A successful local Linux run does not authorize
npm publication.
