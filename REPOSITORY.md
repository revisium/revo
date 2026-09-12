# Repository contract

`revo` is the standalone Revo distribution and composition package. It owns the `revo` binary,
product layout, release channels, process lifecycle, installation, and the final HTTP application.

## Source-of-truth order

1. Accepted ADRs in `docs/adr/` define architecture and ownership.
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
