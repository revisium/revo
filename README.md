<div align="center">

# `@revisium/revo`

**Standalone distribution and composition entrypoint for Revo.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

## Status

Distribution foundation. A temporary binary adapter supports only `revo --version`; cross-platform
channel layout resolution and release metadata validation are also implemented. Product commands
remain in `revo-cli` and are not integrated yet.

## Responsibilities

- Expose the `revo` binary.
- Inject distribution lifecycle capabilities into `revo-cli`.
- Own installation, channel-isolated data layout, services, and process lifecycle.
- Compose compatible releases of `revo-core`, `revo-admin`, and `revo-tui` behind one HTTP listener.
- Select and manage an embedded PostgreSQL process for standalone installations.

## Boundaries

- `revo-core` owns product APIs, domain behavior, and database migrations.
- `revo-admin` owns the static browser SPA.
- `revo-cli` owns command grammar, parsing, help, output, and exit codes.
- `revo-tui` owns terminal UI behavior.
- Dependencies flow from `revo` to released component packages; components do not import `revo`.

## Foundation CLI

After building, the only successful command is:

```sh
pnpm build
node dist/bin/revo.js --version
```

Other commands fail with an explicit placeholder message. This adapter will be replaced by
`revo-cli` integration; command behavior must not be duplicated here. The package manifest is
private during the foundation stage.

## Development

Use Node.js 24.11.1 and pnpm 11.13.0:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm verify
```

See [VERIFICATION.md](VERIFICATION.md) for the complete local gate.
