# Verification

Run installs, builds, tests, and servers only in a fresh isolated container, lab, or CI runner. Do
not install dependencies on the host or reuse another task's caches, volumes, ports, or auth.

Inside the repository in that environment:

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

`pnpm verify` checks formatting, strict TypeScript, Oxlint, the production build, behavior tests,
and full `src/**/*.ts` V8 coverage with text and LCOV reports.

## Test design

- Start with a failing observable behavior, implement it, then refactor.
- Express scenarios through narrow domain DSLs and explicit fixtures, including installer and shell
  behavior. Drivers may hide process and filesystem mechanics, not assertions.
- Keep actions and assertions at one abstraction level. Every test must distinguish a plausible
  defect; do not mirror configuration or private implementation.
- Use isolated real checks when integration behavior matters. A missing platform or unavailable
  provider is not a pass.

After push, require GitHub Actions and Sonar for the exact pull request head. The scan must wait for
the quality gate and `pnpm sonar:issues:local` must confirm the same revision and zero open issues in
the pull request scope. On `master`, the same requirements apply to the exact branch revision.
