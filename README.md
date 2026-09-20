<div align="center">

# `@revisium/revo`

**Standalone distribution and composition entrypoint for Revo.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

## Status

Production CLI foundation. The `revo` binary starts the configured server and prints its verified
public URL through a thin NestJS application context. Cross-platform channel layout resolution,
release metadata validation, and server lifecycle commands are also implemented; installation
commands arrive in later production stages.

## Responsibilities

- Own the `revo` command grammar, help, output, and exit codes.
- Own installation, channel-isolated data layout, services, and process lifecycle.
- Compose compatible releases of `revo-core`, `revo-admin`, and `revo-tui` behind one HTTP listener.
- Select and manage an embedded PostgreSQL process for standalone installations.

## Boundaries

- `revo-core` owns product APIs, domain behavior, and database migrations.
- `revo-admin` owns the static browser SPA.
- `revo-tui` owns terminal UI behavior.
- Dependencies flow from `revo` to released component packages; components do not import `revo`.

## External PostgreSQL TLS

External PostgreSQL URLs use TLS verification by default; `sslmode=disable` is the only explicit
override. Full Core startup with a TLS IP-literal host is currently blocked by a published upstream
PostgreSQL hostname-verification defect and is not ready or supported for that scenario. Private CA
bundles and mutual TLS credentials remain outside the first external-connection scope and require a
separately designed configuration contract.

## CLI

The current commands are:

```sh
node dist/bin/revo.js --help
node dist/bin/revo.js --version
node dist/bin/revo.js version
node dist/bin/revo.js doctor
node dist/bin/revo.js
node dist/bin/revo.js --web
node dist/bin/revo.js tui
node dist/bin/revo.js tui --channel alpha
node dist/bin/revo.js server start
node dist/bin/revo.js server status
node dist/bin/revo.js server stop
```

Running `revo` without arguments ensures the server is running and prints one verified URL. `--web`
also opens that URL in the default browser. `revo tui` starts or reuses the selected local server,
then opens the terminal client against its verified GraphQL endpoint. It requires an interactive
stdin/stdout and is supported on Linux and macOS only; other platforms fail before the server is
started. Exiting the TUI leaves the server running. `--channel`, `--config`, `--data-dir`, and
`--startup-timeout` select the same Revo configuration used by the server commands. Other server
settings, including host, port, public URL, database URL, and log directory, come from the selected
configuration file or environment. Unknown arguments and options fail with exit code 2. The package
manifest remains private during the foundation stage.

## Development

Use Node.js 26.8.2 and pnpm 12.4.1 in an isolated development environment:

```sh
pnpm install --frozen-lockfile
pnpm verify
```

See [VERIFICATION.md](VERIFICATION.md) for the complete local gate.
