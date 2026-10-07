#!/bin/sh
# Smoke test of a Revo installation in a throwaway HOME without host Node.js or pnpm, run from a
# project directory that pins another package manager, with user pnpm settings that would break the
# installation if the installer honoured them.
# Usage:
#   scripts/smoke-install.sh <install script URL>
#   scripts/smoke-install.sh --bundle <directory>
# REVO_INSTALL_SYSTEM_DEPS=1 in the environment lets the installer install a missing system library.
# A bundle must be built with --release-url https://127.0.0.1:$REVO_SMOKE_PORT (default 8443);
# it is served from that origin with a temporary certificate.
set -eu

port=${REVO_SMOKE_PORT:-8443}
system_path=/usr/bin:/bin:/usr/sbin:/sbin
sentinel_id=smoke-sentinel
shared_pnpm_dirs='.cache/pnpm .config/pnpm .local/share/pnpm .local/state/pnpm Library/pnpm Library/Caches/pnpm Library/Preferences/pnpm'

say() {
  printf 'smoke: %s\n' "$*"
}

fail() {
  printf 'smoke: FAILED: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  status=$?
  if [ -n "${command_name:-}" ] && [ -x "$home/.local/bin/$command_name" ]; then
    if [ "$status" -ne 0 ]; then
      revo server logs >&2 || :
    fi
    revo server stop >/dev/null 2>&1 || :
  fi
  if [ -n "${server_pid:-}" ]; then
    kill "$server_pid" 2>/dev/null || :
  fi
  rm -rf "$work"
  exit "$status"
}

clean_env() {
  if [ -n "${ca_bundle:-}" ]; then
    set -- CURL_CA_BUNDLE="$ca_bundle" "$@"
  fi
  env -i HOME="$home" PATH="$host_bin:$system_path" LANG=C.UTF-8 TERM="${TERM:-xterm-256color}" "$@"
}

revo() {
  clean_env "$home/.local/bin/$command_name" "$@"
}

graphql() {
  clean_env curl --fail --silent --show-error --header 'content-type: application/json' \
    --data "{\"query\":\"$1\"}" "$url/graphql"
}

serve_bundle() {
  [ -d "$bundle" ] || fail "bundle directory $bundle does not exist"
  (cd "$bundle" && clean_env sh -c 'sha256sum -c SHA256SUMS 2>/dev/null || shasum -a 256 -c SHA256SUMS') >/dev/null ||
    fail 'SHA256SUMS does not match the bundle'
  printf '[req]\ndistinguished_name=subject\nx509_extensions=loopback\nprompt=no\n[subject]\nCN=127.0.0.1\n[loopback]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n' >"$work/openssl.cnf"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -config "$work/openssl.cnf" \
    -keyout "$work/origin.key" -out "$work/origin.pem" 2>/dev/null || fail 'cannot create a certificate'
  python3 - "$bundle" "$work/origin.pem" "$work/origin.key" "$port" <<'PY' &
import functools
import http.server
import ssl
import sys

directory, cert, key, port = sys.argv[1:5]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(
    ("127.0.0.1", int(port)), functools.partial(QuietHandler, directory=directory)
)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(cert, key)
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
PY
  server_pid=$!
  for trusted in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem /etc/ssl/ca-bundle.pem /etc/pki/tls/certs/ca-bundle.crt; do
    if [ -f "$trusted" ]; then
      cat "$trusted" >"$work/ca-bundle.pem"
      break
    fi
  done
  cat "$work/origin.pem" >>"$work/ca-bundle.pem"
  ca_bundle=$work/ca-bundle.pem
  script_url=https://127.0.0.1:$port/$(cd "$bundle" && ls install*.sh)
  clean_env curl --fail --silent --retry 10 --retry-connrefused --retry-delay 1 --output /dev/null \
    "$script_url" || fail "the bundle is not served at $script_url"
}

prepare_home() {
  mkdir -p "$home" "$host_bin" "$project"
  printf '{ "packageManager": "npm@10.9.0" }\n' >"$project/package.json"
  for tool in node pnpm npm npx corepack; do
    printf '#!/bin/sh\necho %s >>"%s/host-tools.log"\nexit 97\n' "$tool" "$work" >"$host_bin/$tool"
    chmod 755 "$host_bin/$tool"
  done
  for config in .config/pnpm Library/Preferences/pnpm; do
    mkdir -p "$home/$config"
    printf '%s\n' 'ignoreScripts: true' 'optional: false' 'enableGlobalVirtualStore: true' \
      'minimumReleaseAge: 5256000' 'trustPolicy: no-downgrade' 'engineStrict: true' >"$home/$config/config.yaml"
  done
  user_pnpm_files=$(shared_pnpm_files)
}

shared_pnpm_files() {
  for shared in $shared_pnpm_dirs; do
    if [ -e "$home/$shared" ]; then
      (cd "$home" && find "$shared" -print)
    fi
  done | sort
}

check_private_tools() {
  [ ! -e "$work/host-tools.log" ] || fail "host tools were used $1: $(cat "$work/host-tools.log")"
  [ "$(shared_pnpm_files)" = "$user_pnpm_files" ] ||
    fail "shared pnpm data was written $1: $(shared_pnpm_files)"
}

select_command() {
  case "$script_url" in
    */install-alpha.sh) command_name=revo-alpha ;;
    */install.sh) command_name=revo ;;
    *) fail "unknown install script $script_url" ;;
  esac
}

install_revo() {
  (cd "$project" && clean_env curl --fail --silent --show-error --location --proto =https "$script_url" |
    clean_env pnpm_config_ignore_scripts=true PNPM_CONFIG_OFFLINE=true PNPM_CONFIG_ENGINE_STRICT=true \
      REVO_INSTALL_SYSTEM_DEPS="${REVO_INSTALL_SYSTEM_DEPS:-}" sh)
}

check_fresh_install() {
  output=$(install_revo) || fail "installation failed: $output"
  printf '%s\n' "$output"
  version=$(printf '%s\n' "$output" | sed -n 's/^.* \([^ ]*\) is installed\.$/\1/p')
  [ -n "$version" ] || fail 'the installer did not report the installed version'
  printf '%s\n' "$output" | grep -qF "Run \`$command_name\` to start Revo." || fail 'no next step was printed'
  check_private_tools 'by the installer'
  [ "$(revo --version)" = "$version" ] || fail "$command_name --version does not report $version"
  say "installed $command_name $version"
  check_install_contents
}

# The bundled ACP bridges run the user's own claude and codex CLIs, so their native agent binaries
# (ignoredOptionalDependencies in pnpm-workspace.yaml) must stay out of the installation.
check_install_contents() {
  agent_binaries=$(find "$home/.local/share/revo-install" -type d \
    \( -name '*claude-agent-sdk-*' -o -name '*openai+codex@*-darwin-*' -o -name '*openai+codex@*-linux-*' \
    -o -name '*openai+codex@*-win32-*' \) -prune -print)
  [ -z "$agent_binaries" ] || fail "native agent binaries were installed: $agent_binaries"
  say "install size: $(du -sk "$home/.local/share/revo-install" | cut -f1) KiB"
}

start_server() {
  url=$(revo) || fail "$command_name did not start the server"
  case "$url" in
    http://127.0.0.1:*) ;;
    *) fail "unexpected server URL $url" ;;
  esac
  say "server is running at $url"
}

check_admin_and_api() {
  clean_env curl --fail --silent --show-error "$url/" | grep -qi '<!doctype html' ||
    fail 'Admin HTML is not served'
  graphql '{ __typename }' | grep -qF '"__typename":"Query"' || fail 'GraphQL does not answer'
  graphql "mutation { createPlaybook(data: { id: \\\"$sentinel_id\\\", name: \\\"Smoke sentinel\\\" }) { id } }" |
    grep -qF "\"$sentinel_id\"" || fail 'cannot write the data sentinel'
  check_private_tools 'by the first start'
  say 'Admin and GraphQL answer; the data sentinel is written'
}

stop_server() {
  revo server stop >/dev/null || fail "$command_name server stop failed"
  leftover=$(find "$home" -name postmaster.pid -print)
  [ -z "$leftover" ] || fail "PostgreSQL left $leftover"
  say 'server stopped without postmaster.pid'
}

check_sentinel_after_restart() {
  start_server
  graphql "{ playbook(id: \\\"$sentinel_id\\\", scope: DRAFT) { name } }" | grep -qF 'Smoke sentinel' ||
    fail 'the data sentinel did not survive the restart'
  check_private_tools 'by the restart'
  say 'the data sentinel survived the restart'
}

check_reinstall() {
  output=$(install_revo) || fail "reinstallation failed: $output"
  printf '%s\n' "$output" | grep -qF "$version is already installed." ||
    fail "reinstallation did not report $version as already installed"
  say 'reinstalling the same version changes nothing'
}

check_tui() {
  clean_env python3 - "$home/.local/bin/$command_name" <<'PY' || fail 'the TUI did not connect and exit'
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

leader, follower = pty.openpty()
fcntl.ioctl(follower, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
process = subprocess.Popen(
    [sys.argv[1], "tui"], stdin=follower, stdout=follower, stderr=follower, start_new_session=True
)
os.close(follower)
screen = b""
text = b""
def wait_for_exit():
    # The pty closes while the TUI is exiting, slightly before the kernel reports the exit.
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
connected = False
next_quit = 0.0
deadline = time.monotonic() + 60
while process.poll() is None and time.monotonic() < deadline:
    ready, _, _ = select.select([leader], [], [], 0.5)
    if ready:
        try:
            screen += os.read(leader, 65536)
        except OSError:
            wait_for_exit()
            break
    text = re.sub(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\s", b"", screen)
    # The TUI redraws only changed cells, so words of the connected screen can lose letters;
    # the subscription status is a short word that is written whole once updates connect.
    if not connected and b"Live" in text:
        connected = True
        deadline = time.monotonic() + 30
        next_quit = time.monotonic() + 1
    # A key sent while the screen is still settling can be lost, so repeat it until the TUI exits.
    if connected and time.monotonic() >= next_quit:
        try:
            os.write(leader, b"q")
        except OSError:
            wait_for_exit()
            break
        next_quit = time.monotonic() + 3
def report(reason):
    tail = text.decode("utf-8", "replace")[-600:]
    sys.exit(f"{reason}; connected={connected}; last screen text: {tail}")
if process.poll() is None:
    process.kill()
    report("TUI did not exit")
if not connected or process.returncode != 0:
    report(f"TUI exited with {process.returncode}")
PY
  check_private_tools 'by the TUI'
  say 'the TUI connected and exited'
}

main() {
  case "${1:-}" in
    --bundle)
      [ "$#" -eq 2 ] || fail 'usage: smoke-install.sh --bundle <directory>'
      bundle=$(cd "$2" && pwd)
      ;;
    https://*)
      script_url=$1
      ;;
    *) fail 'usage: smoke-install.sh <install script URL> | --bundle <directory>' ;;
  esac
  # Revo refuses log directories under a symlink, and /tmp is one on macOS: use its real path.
  work=$(cd "$(mktemp -d /tmp/revo-smoke.XXXXXX)" && pwd -P)
  home=$work/home
  host_bin=$work/host-bin
  project=$work/project
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  prepare_home
  if [ -n "${bundle:-}" ]; then
    serve_bundle
  fi
  select_command
  check_fresh_install
  start_server
  check_admin_and_api
  stop_server
  check_sentinel_after_restart
  check_reinstall
  check_tui
  stop_server
  say 'passed'
}

main "$@"
