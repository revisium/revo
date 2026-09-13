# Repository contract

`revo` owns the standalone distribution: its CLI, product layout, release channels, installation,
local process and PostgreSQL lifecycle, and final HTTP application.

## Source-of-truth order

1. `REPOSITORY.md` defines architecture and ownership boundaries.
2. `src/` defines shipped behavior and public package contracts.
3. `test/` defines executable behavior contracts.
4. `README.md` documents user-facing behavior.

Generated `dist/`, coverage output, and package tarballs are never source files.

## Repository boundaries

- Revo commands are thin NestJS entrypoints over focused application services.
- Revo Core owns product APIs, domain behavior, its schema, and migrations. Revo integrates only
  its public runtime contract.
- Revo Admin owns the static browser application; Revo TUI owns terminal UI behavior.
- Revo composes pinned released components without copying their source or domain behavior.

The foundation intentionally contains no component dependency, server, database, Docker, or
installer implementation. Add each production capability only in its assigned change.

## Composition contract

- Revo owns the final Nest/Express application and its single public HTTP listener.
- Core registers backend routes through its public runtime contract.
- Revo serves Revo Admin static SPA assets and installs its fallback after every backend route.
- Standalone binds to loopback by default; Docker may explicitly bind to `0.0.0.0`.
- Stable and alpha use separate configuration, data, state, cache, and runtime directories.
- Revo owns embedded or external PostgreSQL selection and process lifecycle.
- Revo Core owns its schema, Prisma migrations, DBOS migrations, and migration order.
- Revo calls Core's supported database preparation API and does not inspect internal package paths.
