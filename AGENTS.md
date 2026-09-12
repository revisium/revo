# Agent instructions

Use the canonical workspace agent playbook and the repository overlays in
`REPOSITORY.md`, `VERIFICATION.md`, and `REVIEW.md`.

`revo-cli` owns command grammar, parsing, help, output, and exit codes. This repository owns the
`revo` binary adapter and injects distribution lifecycle capabilities. Do not duplicate or retire
`revo-cli`; the foundation adapter is temporary pending package integration.

For local Node setup, run `corepack enable pnpm` once. The `packageManager` field pins the pnpm
version used by bare `pnpm` commands.
