#!/bin/sh
# Installs @@PRODUCT@@ @@VERSION@@ with private copies of Node.js and pnpm.
# Usage: curl -fsSL <URL of this script> | sh
# Only the last line runs anything, so a truncated download changes nothing.

define_release() {
  channel='@@CHANNEL@@'
  product='@@PRODUCT@@'
  command_name='@@COMMAND@@'
  version='@@VERSION@@'
  release_url='@@RELEASE_URL@@'
  package_sha256='@@PACKAGE_SHA256@@'
  lockfile_sha256='@@LOCKFILE_SHA256@@'
  workspace_sha256='@@WORKSPACE_SHA256@@'
  node_version='@@NODE_VERSION@@'
  node_url='@@NODE_URL@@'
  pnpm_version='@@PNPM_VERSION@@'
  pnpm_url='@@PNPM_URL@@'
}

toolchain_checksums() {
  case "$platform" in
    linux-x64) node_sha256='@@NODE_SHA256_LINUX_X64@@' pnpm_sha256='@@PNPM_SHA256_LINUX_X64@@' ;;
    linux-arm64) node_sha256='@@NODE_SHA256_LINUX_ARM64@@' pnpm_sha256='@@PNPM_SHA256_LINUX_ARM64@@' ;;
    darwin-x64) node_sha256='@@NODE_SHA256_DARWIN_X64@@' pnpm_sha256='@@PNPM_SHA256_DARWIN_X64@@' ;;
    darwin-arm64) node_sha256='@@NODE_SHA256_DARWIN_ARM64@@' pnpm_sha256='@@PNPM_SHA256_DARWIN_ARM64@@' ;;
  esac
}

say() {
  printf '%s\n' "$*"
}

fail() {
  printf '%s install: %s\n' "$command_name" "$*" >&2
  exit 1
}

unsupported() {
  fail "unsupported platform ($1); Revo supports Linux x64 and arm64 with glibc 2.35 or newer, and macOS 15 or newer."
}

at_least() {
  IFS=. read -r found_major found_minor _ <<EOF
$1
EOF
  case "$found_major:${found_minor:-0}" in
    *[!0-9:]* | :*) return 1 ;;
  esac
  [ "$found_major" -gt "$2" ] || { [ "$found_major" -eq "$2" ] && [ "${found_minor:-0}" -ge "$3" ]; }
}

detect_platform() {
  system=$(uname -s)
  machine=$(uname -m)
  case "$system/$machine" in
    Linux/x86_64 | Linux/amd64) platform=linux-x64 ;;
    Linux/aarch64 | Linux/arm64) platform=linux-arm64 ;;
    Darwin/x86_64) platform=darwin-x64 ;;
    Darwin/arm64) platform=darwin-arm64 ;;
    *) unsupported "$system $machine" ;;
  esac
  if [ "$system" = Linux ]; then
    glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || unsupported 'no glibc'
    case "$glibc" in
      'glibc '[0-9]*) at_least "${glibc#glibc }" 2 35 || unsupported "$glibc" ;;
      *) unsupported 'no glibc' ;;
    esac
  else
    macos=$(sw_vers -productVersion 2>/dev/null) || unsupported 'unknown macOS version'
    at_least "$macos" 15 0 || unsupported "macOS $macos"
  fi
  toolchain_checksums
}

require_tools() {
  for tool in curl tar gzip awk sed; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is required; install it and run the installer again."
  done
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 ||
    fail 'sha256sum or shasum is required; install it and run the installer again.'
}

locate_installation() {
  [ -n "${HOME:-}" ] || fail 'HOME is not set.'
  install_root=${REVO_INSTALL_ROOT:-$HOME/.local/share/revo}
  case "$install_root" in /*) ;; *) fail 'REVO_INSTALL_ROOT must be an absolute path.' ;; esac
  channel_root=$install_root/$channel
  node_home=$channel_root/node/$node_version
  pnpm_home=$channel_root/pnpm/$pnpm_version
  version_home=$channel_root/versions/$version
  staging=$channel_root/.staging
  lock=$channel_root/.lock
  bin_dir=$HOME/.local/bin
  command_link=$bin_dir/$command_name
  command_target=$channel_root/current/bin/$command_name
}

check_command_link() {
  if [ -e "$command_link" ] || [ -L "$command_link" ]; then
    case "$(readlink "$command_link" 2>/dev/null)" in
      "$channel_root"/*) ;;
      *) fail "$command_link exists and was not created by this installer; remove it and run the installer again." ;;
    esac
  fi
}

acquire_lock() {
  mkdir -p "$channel_root" || fail "cannot create $channel_root."
  if ! mkdir "$lock" 2>/dev/null; then
    owner=$(cat "$lock/pid" 2>/dev/null) || owner=
    if [ -z "$owner" ]; then
      fail "another installation of $product may be running; if it is not, remove $lock and run the installer again."
    fi
    if kill -0 "$owner" 2>/dev/null; then
      fail "another installation of $product is running (pid $owner)."
    fi
    rm -rf "$lock"
    mkdir "$lock" 2>/dev/null || fail "another installation of $product started at the same time."
  fi
  lock_held=1
  printf '%s\n' "$$" >"$lock/pid" || fail "cannot write $lock/pid."
  rm -rf "$staging" || fail "cannot remove $staging."
  mkdir "$staging" || fail "cannot create $staging."
}

cleanup() {
  if [ "$lock_held" = 1 ]; then
    rm -rf "$staging" "$lock"
  fi
}

read_active_version() {
  previous=$(readlink "$channel_root/current" 2>/dev/null) || previous=
  case "$previous" in versions/?*) previous=${previous#versions/} ;; *) previous= ;; esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi | awk '{ print $1 }'
}

fetch() {
  curl_error=$(curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 \
    --connect-timeout 15 --speed-limit 1024 --speed-time 30 --silent --show-error \
    --output "$2" "$1" 2>&1) ||
    fail "download failed: $1 ($(printf '%s\n' "$curl_error" | tail -n 1)); nothing was changed."
  [ "$(sha256_of "$2")" = "$3" ] || fail "checksum mismatch for $1; nothing was changed."
}

download_artifacts() {
  if [ ! -x "$node_home/bin/node" ]; then
    say "Downloading Node.js $node_version..."
    fetch "$node_url/node-v$node_version-$platform.tar.gz" "$staging/node.tar.gz" "$node_sha256"
  fi
  if [ ! -x "$pnpm_home/pnpm" ]; then
    say "Downloading pnpm $pnpm_version..."
    fetch "$pnpm_url/pnpm-$platform.tar.gz" "$staging/pnpm.tar.gz" "$pnpm_sha256"
  fi
  if [ ! -d "$version_home" ]; then
    say "Downloading $product $version..."
    fetch "$release_url/revo-$version.tgz" "$staging/revo.tgz" "$package_sha256"
    fetch "$release_url/pnpm-lock.yaml" "$staging/pnpm-lock.yaml" "$lockfile_sha256"
    fetch "$release_url/pnpm-workspace.yaml" "$staging/pnpm-workspace.yaml" "$workspace_sha256"
  fi
}

unpack() {
  archive=$1
  target=$2
  shift 2
  mkdir "$target" || fail "cannot create $target."
  tar -xzf "$archive" -C "$target" "$@" || fail "cannot unpack $archive."
}

publish() {
  rm -rf "$2" || fail "cannot replace $2."
  mkdir -p "${2%/*}" || fail "cannot create ${2%/*}."
  mv "$1" "$2" || fail "cannot install $2."
}

install_toolchain() {
  if [ -f "$staging/node.tar.gz" ]; then
    unpack "$staging/node.tar.gz" "$staging/node" --strip-components=1
    [ "$("$staging/node/bin/node" --version 2>/dev/null)" = "v$node_version" ] ||
      fail "Node.js $node_version does not run on this machine."
    publish "$staging/node" "$node_home"
  fi
  if [ -f "$staging/pnpm.tar.gz" ]; then
    unpack "$staging/pnpm.tar.gz" "$staging/pnpm"
    [ "$("$staging/pnpm/pnpm" --version 2>/dev/null)" = "$pnpm_version" ] ||
      fail "pnpm $pnpm_version does not run on this machine."
    publish "$staging/pnpm" "$pnpm_home"
  fi
}

quoted() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

write_launcher() {
  mkdir "$1/bin" || return 1
  cat >"$1/bin/$command_name" <<EOF || return 1
#!/bin/sh
exec $(quoted "$node_home/bin/node") $(quoted "$version_home/dist/bin/revo.js") "\$@"
EOF
  chmod 755 "$1/bin/$command_name"
}

install_revo() {
  revo=$staging/revo
  unpack "$staging/revo.tgz" "$revo" --strip-components=1
  cp "$staging/pnpm-lock.yaml" "$staging/pnpm-workspace.yaml" "$revo/" || fail "cannot prepare $revo."
  say "Installing $product dependencies..."
  pnpm_data=$channel_root/pnpm-data
  (cd "$revo" && PATH="$node_home/bin:$PATH" PNPM_HOME="$pnpm_data/home" "$pnpm_home/pnpm" install \
    --prod --frozen-lockfile --store-dir "$pnpm_data/store" --state-dir "$pnpm_data/state" \
    --config.cache-dir="$pnpm_data/cache") || fail 'dependency installation failed; run the installer again.'
  write_launcher "$revo" || fail "cannot create the $command_name launcher."
  publish "$revo" "$version_home"
}

activate_version() {
  ln -s "versions/$version" "$staging/current" || fail "cannot link $product $version."
  "$node_home/bin/node" -e 'require("fs").renameSync(process.argv[1], process.argv[2])' \
    "$staging/current" "$channel_root/current" || fail "cannot switch to $product $version."
}

link_command() {
  [ "$(readlink "$command_link" 2>/dev/null)" = "$command_target" ] && return
  mkdir -p "$bin_dir" || fail "cannot create $bin_dir."
  ln -sf "$command_target" "$command_link" || fail "cannot create $command_link."
}

report_installed() {
  if [ -z "$previous" ]; then
    say "$product $version is installed."
    return
  fi
  say "$product $version is installed (previous version $previous)."
  say "A running $product server keeps version $previous until it is restarted: run \`$command_name server stop\`, then \`$command_name\`."
}

print_next_step() {
  # shellcheck disable=SC2016 # Printed literally for the user to copy into a shell profile.
  path_line='export PATH="$HOME/.local/bin:$PATH"'
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) say "Your PATH does not include ~/.local/bin; add this line to your shell profile: $path_line" ;;
  esac
  say "Run \`$command_name\` to start Revo."
}

main() {
  lock_held=0
  define_release
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  detect_platform
  require_tools
  locate_installation
  check_command_link
  acquire_lock
  read_active_version
  if [ "$previous" = "$version" ] && [ -d "$version_home" ]; then
    link_command
    say "$product $version is already installed."
  else
    download_artifacts
    install_toolchain
    [ -d "$version_home" ] || install_revo
    activate_version
    link_command
    report_installed
  fi
  print_next_step
}

main "$@"
