<div align="center">

# `@revisium/revo`

**Standalone distribution and composition entrypoint for Revo.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

## Status

Initial architecture stage. The target API is not implemented.

## Responsibilities

- Expose the `revo` binary.
- Manage the embedded PostgreSQL lifecycle.
- Own installation, data layout, services, and process lifecycle.
- Assemble compatible `revo-core` and `revo-cli` versions.

## Boundaries

- `revo-cli` owns all terminal commands and terminal UX.
- `revo-core` owns daemon and product behavior.
- Dependencies flow from `revo` to `revo-cli` and `revo-core`; neither imports `revo`.

## Target API

Planned:

```sh
npx @revisium/revo install
revo status
```

## Dependencies

- [`@revisium/revo-core`](https://github.com/revisium/revo-core)
- [`@revisium/revo-cli`](https://github.com/revisium/revo-cli)
