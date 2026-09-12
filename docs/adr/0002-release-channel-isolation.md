# ADR 0002: Isolate stable and alpha channels

Status: Accepted

## Context

Alpha builds must be testable on a machine that also runs stable Revo. Sharing mutable paths would
allow an alpha migration, lock, process, or cache entry to affect the stable installation.

## Decision

Stable and alpha use distinct configuration, data, state, cache, and runtime directories. Layouts
follow native Windows and macOS roots and the XDG base-directory variables on Linux. The resolver
receives platform, home directory, and environment as inputs so callers can inspect a layout before
creating any directory.

Stable uses the npm `latest` dist-tag. Alpha uses the npm `alpha` dist-tag and a prerelease SemVer.
Release metadata validation enforces these pairs.

The selected channel is part of the distribution lifecycle capability input supplied to `revo-cli`.
Command parsing and presentation remain owned by `revo-cli`; this package owns channel validation and
path resolution.

## Consequences

- Stable and alpha can run side by side without sharing PostgreSQL data, locks, or configuration.
- Installers and commands must preserve the selected channel through every lifecycle operation.
- Promotion changes a channel pointer only after the exact release has passed its channel gates.
