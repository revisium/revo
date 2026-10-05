# Revo release bundle

A release consists of flat GitHub Release assets for one version and one channel:

| Asset                              | Content                                                    |
| ---------------------------------- | ---------------------------------------------------------- |
| `revo-<version>.tgz`               | the `pnpm pack` output of the checked-out, built package   |
| `pnpm-lock.yaml`                   | the lockfile for `pnpm install --prod --frozen-lockfile`   |
| `pnpm-workspace.yaml`              | the pnpm settings, including the allowed dependency builds |
| `install-alpha.sh` or `install.sh` | the channel install script with every checksum embedded    |
| `SHA256SUMS`                       | SHA-256 of exactly the four assets above                   |

The install script downloads the assets from
`https://github.com/revisium/revo/releases/download/v<version>/`, Node.js from `nodejs.org`, and
pnpm from its GitHub releases, and checks each download against the embedded SHA-256 before using
it. The pnpm version is the `packageManager` pin and the Node.js version is `.nvmrc`.

## Build

The checked-out `package.json` version is the release version: alpha requires a prerelease such as
`0.1.0-alpha.2`, stable requires a plain `X.Y.Z`. The command never publishes anything.

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/build-release-bundle.mjs --channel alpha --output /tmp/revo-bundle
(cd /tmp/revo-bundle && sha256sum -c SHA256SUMS)
```

`--release-url` changes where the install script downloads the Revo assets from. CI uses it to
serve a bundle from `https://127.0.0.1:8443`.

## Smoke test

`scripts/smoke-install.sh` installs into a throwaway `HOME` with host Node.js and pnpm hidden, then
checks the version, the first start, the Admin HTML and GraphQL, a clean stop without
`postmaster.pid`, a data sentinel across a restart, a same-version reinstall, and `tui` under a
pseudo-terminal.

```sh
scripts/smoke-install.sh https://github.com/revisium/revo/releases/download/v<version>/install-alpha.sh
```

For a local bundle built with `--release-url https://127.0.0.1:8443`, the script serves it over
HTTPS with a temporary certificate:

```sh
scripts/smoke-install.sh --bundle /tmp/revo-bundle
```

## Release workflow

Pushing a `v<version>` tag that matches `package.json` runs `.github/workflows/release.yml`:

1. build and verify the bundle for the channel implied by the version;
2. create the GitHub release as a draft, upload the assets, and publish it (a prerelease for alpha);
3. run the smoke test from the release URL on Linux x64 and arm64 (Ubuntu 22.04 and 24.04) and
   macOS 15, macOS 26, and macOS 15 Intel;
4. after a green smoke, publish the channel install script to GitHub Pages, for example
   `https://revisium.github.io/revo/install-alpha.sh`, keeping the other channel's script.

The workflow requires GitHub Pages with the GitHub Actions source. Enable immutable releases so that
published assets cannot change.
