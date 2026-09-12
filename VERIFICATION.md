# Verification

Run before requesting review:

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

`pnpm verify` checks formatting, strict TypeScript, Oxlint, unit behavior, the production build, and
the exact npm tarball allowlist. The package check is a dry run and does not create or publish a
tarball.

Publication is deliberately blocked by `private: true` and the `prepublishOnly` foundation guard.
Publishing, tagging, and release promotion require a later release-train change and explicit
authorization.

After a push, GitHub Actions must pass. Provider checks are required only when added to this
repository's CI and documented here.
