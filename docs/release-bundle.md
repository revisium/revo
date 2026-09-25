# Revo release bundle

`pnpm build:release-bundle` creates a private, versioned input for the POSIX
installer. It builds and validates the package, downloads the pinned Node and
pnpm artifacts, writes the v3 manifest, and performs a production frozen
install check. It never publishes npm packages, creates Git refs, changes DNS,
or moves a channel pointer.

## Release-train contract

The release train is the only authority that chooses a release version. Its
write-mode transition updates the checked-out package metadata and creates the
versioned branch/tag. The bundle generator reads that snapshot; it must not
calculate a next version or perform a version bump. Stable snapshots use
`X.Y.Z`; alpha snapshots use `X.Y.Z-alpha.N`.

The snapshot must have matching values in `package.json`, the packed tarball,
the manifest, channel metadata, and the installed CLI. The package manager,
core/admin dependency pins, lockfile, and workspace file are part of the same
snapshot.

## Private staging

Run from the checked-out release snapshot with a canonical HTTPS origin:

```sh
pnpm run build:release-bundle \\
  --channel stable \\
  --origin https://staging.example.test/revo \\
  --output /private/staging/revo-bundle
```

The output directory must be absent or an empty private directory. A verified
bundle contains `release-bundle-report.json`, `release-bundle.ok`,
`SHA256SUMS`, `manifest.json`, `channel.json`, `install.sh`, the package
artifacts, and `frozen-install.ok`. Verify the final bytes before serving them:

```sh
(cd /private/staging/revo-bundle && sha256sum -c SHA256SUMS)
```

Serve the files under the paths encoded by the manifest:

- `/revo/releases/<version>/manifest.json`
- `/revo/releases/<version>/install.sh`
- `/revo/releases/<version>/revo-<version>.tgz`
- `/revo/channels/stable.json` or `/revo/channels/alpha.json`

The private acceptance gate must use a fresh non-root sandbox and the real
`cat install.sh | sh` pipe. It covers version/doctor output, server lifecycle,
PostgreSQL cleanup, Admin/API read-write, TUI GraphQL read through a real PTY,
no-TTY failure, and repeated install/restart behavior. A private acceptance
does not prove public HTTPS/DNS delivery.

## Safety boundaries

- Do not run npm publish from this repository task.
- Do not invent an alpha version when the release train has not produced one.
- Do not reuse a non-empty output directory; a failed build has no
  `release-bundle.ok` marker and must be discarded after evidence collection.
- Do not treat a rendered TUI screen alone as a connected acceptance; verify a
  backend read and a clean second launch.
- Do not promote stable/alpha or alter production DNS as part of bundle
  generation.
