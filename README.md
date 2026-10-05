<div align="center">

# `@revisium/revo`

**Standalone distribution and composition entrypoint for Revo.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

## Status

Alpha. The `revo` binary starts the configured server and prints its verified public URL through a
thin NestJS application context. Cross-platform channel layout resolution, release metadata
validation, server lifecycle commands, and the alpha installer are implemented.

## Install

Install or update the alpha channel with one command:

```sh
curl -fsSL https://revisium.github.io/revo/install-alpha.sh | sh
```

The alpha channel's command is `revo-alpha`; the stable channel will use `revo`. Run `revo-alpha`
to start the server and print its URL. The installer does not start the server itself.

Supported platforms are Linux x64 and arm64 with glibc 2.35 or newer (for example Ubuntu 22.04 or
newer), and macOS 15 or newer on Apple Silicon or Intel. Administrator rights and preinstalled
Node.js, pnpm, or PostgreSQL are not required: the installer downloads its own Node.js and pnpm,
verifies every download against SHA-256 checksums embedded in the script, and never uses or changes
copies already installed on the system. Your pnpm settings do not change what it installs; registry,
proxy, and credential settings still apply.

The installer creates `~/.local/bin/revo-alpha`. If `~/.local/bin` is not on your `PATH`, it prints
the line to add to your shell profile; it never edits shell profiles itself:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

New versions are published on the [Releases](https://github.com/revisium/revo/releases) page; use
**Watch → Custom → Releases** to be notified. Running the install command again installs the newest
alpha next to the current version and switches `revo-alpha` to it. A server that is already running
keeps the previous version until you restart it with `revo-alpha server stop` and `revo-alpha`.

### Where Revo lives

The program lives in `~/.local/share/revo-install/alpha` (`$REVO_INSTALL_ROOT/alpha` when that
variable is set): private Node.js and pnpm, one directory per installed version, and the `current`
link to the active version. User data is stored separately and the installer never touches it:

| Platform | Data, configuration, state, and logs                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------- |
| Linux    | `~/.local/share/revo-alpha`, `~/.config/revo-alpha`, `~/.local/state/revo-alpha`, `~/.cache/revo-alpha` |
| macOS    | `~/Library/Application Support/Revo Alpha`, `~/Library/Caches/Revo Alpha`                               |

On Linux the `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` variables
move these directories. `revo-alpha doctor` prints the paths in use.

### Uninstall

Stop the server, then remove the program and the command:

```sh
revo-alpha server stop
rm -rf ~/.local/share/revo-install/alpha ~/.local/bin/revo-alpha
```

Your data stays in place. To remove it as well, which cannot be undone, delete the data directories
listed above, for example on Linux:

```sh
rm -rf ~/.local/share/revo-alpha ~/.config/revo-alpha ~/.local/state/revo-alpha ~/.cache/revo-alpha
```

## Responsibilities

- Own the `revo` command grammar, help, output, and exit codes.
- Own installation, channel-isolated data layout, services, and process lifecycle.
- Compose compatible releases of `revo-core`, `revo-admin`, and `revo-tui` behind one HTTP listener.
- Select and manage an embedded PostgreSQL process for standalone installations.

## Boundaries

- `revo-core` owns product APIs, domain behavior, and database migrations.
- `revo-admin` owns the static browser SPA.
- `revo-tui` owns terminal UI behavior.
- Dependencies flow from `revo` to released component packages; components do not import `revo`.

## External PostgreSQL TLS

External PostgreSQL URLs use TLS verification by default; `sslmode=disable` is the only explicit
override. Full Core startup with a TLS IP-literal host is currently blocked by a published upstream
PostgreSQL hostname-verification defect and is not ready or supported for that scenario. Private CA
bundles and mutual TLS credentials remain outside the first external-connection scope and require a
separately designed configuration contract.

## CLI

The current commands are:

```sh
node dist/bin/revo.js --help
node dist/bin/revo.js --version
node dist/bin/revo.js version
node dist/bin/revo.js doctor
node dist/bin/revo.js
node dist/bin/revo.js --web
node dist/bin/revo.js tui
node dist/bin/revo.js tui --channel alpha
node dist/bin/revo.js server start
node dist/bin/revo.js server status
node dist/bin/revo.js server stop
```

Running `revo-alpha` without arguments ensures the server is running and prints one verified URL.
`--web` also opens that URL in the default browser. `revo-alpha tui` starts or reuses the selected local server,
then opens the terminal client against its verified GraphQL endpoint. It requires an interactive
stdin/stdout and is supported on Linux and macOS only; other platforms fail before the server is
started. Exiting the TUI leaves the server running. `--channel`, `--config`, `--data-dir`, and
`--startup-timeout` select the same Revo configuration used by the server commands. Other server
settings, including host, port, public URL, database URL, and log directory, come from the selected
configuration file or environment. Unknown arguments and options fail with exit code 2. The package
manifest remains private during the foundation stage.

Each installed command belongs to one channel: `revo-alpha` always runs the alpha channel and
`revo` the stable one, and the commands in Revo's messages name the channel in use. A command
refuses `--channel` or `REVO_CHANNEL` naming another channel. If a server is already running when
you start a different installed version, `revo-alpha` prints a notice that the server keeps its
version until you run `revo-alpha server stop` and then `revo-alpha`. The examples above run the
built package directly and stay on the channel that its version selects.

## Server logs

A started server appends its own and Revo Core's output to a private `server.log` (mode `0600`)
next to the lifecycle journal shown by `revo-alpha server logs`, in
`<log directory>/<channel>/<data directory hash>/`. Embedded PostgreSQL writes to `postgres.log` in
the same directory. Database credentials are redacted. When a start fails, `revo-alpha server start`
prints the reason, the log path, and the last 40 lines of that start; a PostgreSQL failure also
names its own reason and `postgres.log`. A start over a server that no longer answers but still owns
the data directory is refused with that explanation.

Startup progress (`--progress=jsonl`) is best-effort: a slow or failed progress read or write is
skipped with a warning on stderr, and a server that started still exits with code 0.

The control socket lives in a private `/tmp/revo-<uid>/` directory, isolated per channel and data
directory, so long home directories and user names stay within the macOS socket path limit.

## Upgrades and the database backup

The embedded database records the newest Revo version that opened it in `data-version.json` in the
channel's data directory (`revo-alpha doctor` prints that directory). A start on data that a newer Revo
version opened is refused before PostgreSQL starts and leaves the data unchanged; run that version
or a newer one. An unreadable `data-version.json` stops the start the same way and names the file.

The first start of a different version copies the stopped database to `database-backup` in the data
directory before PostgreSQL starts and before Revo Core changes the database structure. Revo Core
does not report whether its migrations will change anything, so every version change makes a copy.
Only the latest copy is kept. A new copy replaces it only once complete, so an interrupted backup
leaves the previous copy intact and the next start retries. When the disk has no room for the copy,
the start fails without changing the database. Copying counts toward the startup timeout.

The backup is insurance, not a rollback: Revo does not support returning to an earlier version. To
restore the database from the backup, stop the server and replace the database with the copy. On
Linux, for the alpha channel:

```sh
revo-alpha server stop
cd ~/.local/share/revo-alpha
rm -rf postgres data-version.json
cp -Rp database-backup/. .
```

On macOS the data directory is `~/Library/Application Support/Revo Alpha/data`; the stable channel
uses `revo`, `~/.local/share/revo`, and `~/Library/Application Support/Revo/data`. The restored
database is the database as it was before that upgrade, and anything written since is lost. Its
`data-version.json` names the version that last opened it: only that version or a newer one starts
it, and a newer one backs it up and upgrades it again. A copy without `data-version.json` comes from
data written before Revo recorded versions.

If the first start of a new version fails during the database change, `data-version.json` already
names the new version, so an older Revo refuses the data. Retry or fix the new version; do not start
the old version on the same data. To go back, restore the backup as above.

An external PostgreSQL database (`REVO_DATABASE_URL`) gets neither the version check nor the
backup; back it up with your own tools before you upgrade.

## Development

Use Node.js 26.8.2 and pnpm 12.8.2 in an isolated development environment:

```sh
pnpm install --frozen-lockfile
pnpm verify
```

See [VERIFICATION.md](VERIFICATION.md) for the complete local gate and
[docs/release-bundle.md](docs/release-bundle.md) for release assets and the installer smoke test.
