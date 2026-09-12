# ADR 0001: Compose Revo behind one HTTP listener

Status: Accepted

## Context

The standalone product combines API routes from Revo Core and a browser UI from Revo Admin. Revo
Admin is a static SPA, so it does not require a second production server or SSR process.

## Decision

The `revo` package owns the final Nest/Express application and its single public HTTP listener.
Released `revo-core` runtime APIs register GraphQL, REST, MCP, and health routes. Revo then serves
released `revo-admin` assets and installs the SPA fallback after all backend routes. The fallback
must never intercept backend routes.

The default standalone bind address is loopback. Docker may explicitly bind the same application to
`0.0.0.0`. The TUI calls the same backend API and does not create another server.

`revo-cli` owns command grammar, parsing, help, output, and exit codes. This package exposes the
`revo` binary as a thin composition adapter and injects database, server, installer, update, and
other distribution lifecycle capabilities into `revo-cli` rather than reimplementing commands.

## Consequences

- Browser UI and APIs share one origin and need no production proxy or CORS setup.
- Revo Admin publishes static client assets and has no runtime SSR responsibility.
- Revo Core must expose a supported composition API rather than require internal path discovery.
- The component packages remain independently versioned; Revo pins a tested set of releases.
- Command behavior remains independently testable in `revo-cli`; this repository tests composition
  and capability wiring.
