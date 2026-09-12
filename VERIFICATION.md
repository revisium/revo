# Verification

Run before requesting review:

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

`pnpm verify` checks formatting, strict TypeScript, Oxlint, unit behavior, and the production build.

After a push, GitHub Actions must pass. Provider checks are required only when added to this
repository's CI and documented here.
