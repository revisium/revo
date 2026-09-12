# Repository contract

`revo` is the standalone Revo distribution and composition package. It owns the `revo` binary,
product layout, release channels, process lifecycle, installation, and the final HTTP application.

## Source-of-truth order

1. `REPOSITORY.md` defines architecture and ownership boundaries.
2. `src/` defines shipped behavior and public package contracts.
3. `test/` defines executable behavior contracts.
4. `README.md` documents user-facing behavior.

Generated `dist/`, coverage output, and package tarballs are never source files.

## Repository boundaries

- `revo-cli` owns command grammar, argument parsing, help, terminal output, and exit codes.
- `revo-core` owns product APIs, domain behavior, and its database migrations.
- `revo-admin` owns the static browser application.
- `revo-tui` owns terminal UI behavior.
- This repository exposes the `revo` binary as a composition adapter, injects distribution lifecycle
  capabilities into `revo-cli`, and composes released package versions. It does not copy component
  source or duplicate command behavior.

The foundation intentionally contains no component dependency, server, database, daemon, Docker,
or installer implementation. Its minimal binary is a placeholder pending `revo-cli` integration.

## Composition contract

- Revo owns the final Nest/Express application and its single public HTTP listener.
- Revo Core registers GraphQL, REST, MCP, and health routes through a supported composition API.
- Revo serves Revo Admin static SPA assets and installs its fallback after every backend route.
- Standalone binds to loopback by default; Docker may explicitly bind to `0.0.0.0`.
- Stable and alpha use separate configuration, data, state, cache, and runtime directories.
- Revo owns embedded or external PostgreSQL selection and process lifecycle.
- Revo Core owns its schema, Prisma migrations, DBOS migrations, and migration order.
- Revo calls Core's supported database preparation API and does not inspect internal package paths.
