# Review rules

- Keep stable and alpha configuration, data, state, cache, and runtime paths isolated.
- Resolve operating-system paths only from the injected platform, home directory, and environment.
- Treat release metadata as untrusted input and reject unknown or inconsistent fields.
- Read package name and version from `package.json`; do not duplicate them in CLI output.
- Keep NestJS entrypoints, commands, and Core adapters thin. Domain and migration behavior remains
  in Core and is reached only through its public runtime.
- Do not add component dependencies before their public runtime contracts are released.
- Apply SOLID where it creates a current boundary; do not add generic utilities, wrapper interfaces,
  or framework layers speculatively.
- Keep each function, class, test, and fixture at one level of abstraction.
- Prefer public behavior contracts over framework wiring or trivial delegation tests.
- Review the exact pushed head. CI success from another revision, a skipped provider, a failed
  quality gate, or any scoped open Sonar issue is not approval evidence.
