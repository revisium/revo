# Review rules

- Keep stable and alpha configuration, data, state, cache, and runtime paths isolated.
- Resolve operating-system paths only from the injected platform, home directory, and environment.
- Treat release metadata as untrusted input and reject unknown or inconsistent fields.
- Read package name and version from `package.json`; do not duplicate them in CLI output.
- Keep the binary composition adapter thin. Command grammar, parsing, help, output, and exit codes
  belong to `revo-cli` and must not be duplicated here.
- Treat the foundation command implementation as a temporary placeholder pending `revo-cli`
  integration.
- Do not add component dependencies before their public runtime contracts are released.
- Package contents must match the exact allowlist in the package dry-run check.
- Do not weaken the private-package publication guard in a foundation change.
