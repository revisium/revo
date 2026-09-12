# ADR 0003: Keep database ownership with Revo Core

Status: Accepted

## Context

Standalone Revo may provide an embedded PostgreSQL process, while Docker deployments may provide a
database URL. Schema knowledge and migration order must not be duplicated in the distribution.

## Decision

The `revo` package owns database process selection and lifecycle: it starts and stops embedded
PostgreSQL when selected, or passes through an explicitly configured external database URL.

`revo-core` owns its application schema, Prisma migrations, DBOS system migrations, and their order.
It must expose a supported, idempotent preparation API with observable stages. Revo calls that API
before opening the public listener and never searches Core's internal package paths or runs private
migration files directly.

Database lifecycle operations are exposed to `revo-cli` as injected distribution capabilities.
`revo-cli` owns their command grammar and output but does not take ownership of PostgreSQL or Core
migrations.

## Consequences

- Revo can report migration progress without parsing Core logs.
- Core package tests must cover a fresh database and repeated preparation.
- Database backup, rollback compatibility, and destructive migration policy require separate ADRs
  before update functionality is implemented.
