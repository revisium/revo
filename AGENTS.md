# Repository agent instructions

Read [REPOSITORY.md](REPOSITORY.md), [REVIEW.md](REVIEW.md), and
[VERIFICATION.md](VERIFICATION.md) before editing.

Keep the CLI in this repository. Implement commands as thin NestJS entrypoints over product
services and the public Revo Core runtime; do not deep-import Core internals or move domain
behavior out of Core.

Prefer behavior-first TDD with readable scenario DSLs and explicit fixtures, including installer
work. Keep production code and tests SOLID, focused, and at one level of abstraction.

Pull requests use the repository template and a short English description of the final outcome.
Before handoff, review the exact branch head and require CI, the Sonar quality gate, and scoped open
issue inspection to pass for that same revision.
