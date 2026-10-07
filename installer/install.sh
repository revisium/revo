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
    *) fail "no checksums for $platform." ;;
  esac
}

# Shared libraries the private Node.js loads that minimal images lack, one package per package manager.
required_libraries='libatomic.so.1'

library_package() {
  case "$2:$1" in
    libatomic.so.1:apt-get | libatomic.so.1:zypper) package=libatomic1 ;;
    libatomic.so.1:dnf | libatomic.so.1:yum) package=libatomic ;;
    libatomic.so.1:pacman) package=gcc-libs ;;
    *) package= ;;
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
    *) ;;
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

# ldconfig knows every library the loader finds; the common directories are the fallback when it
# cannot answer.
library_present() {
  case "$ldconfig_cache" in
    *' => '*) printf '%s\n' "$ldconfig_cache" | awk -v name="$1" '$1 == name { found = 1 } END { exit !found }' ;;
    *)
      # REVO_TEST_LIBRARY_DIRS (test-only) replaces the directories.
      for directory in ${REVO_TEST_LIBRARY_DIRS:-/lib /lib64 /usr/lib /usr/lib64 /usr/local/lib /lib/*-linux-gnu /usr/lib/*-linux-gnu}; do
        [ ! -e "$directory/$1" ] || return 0
      done
      return 1
      ;;
  esac
}

find_missing_libraries() {
  ldconfig_cache=
  if command -v ldconfig >/dev/null 2>&1; then
    ldconfig_cache=$(ldconfig -p 2>/dev/null) || ldconfig_cache=
  elif [ -x /sbin/ldconfig ]; then
    ldconfig_cache=$(/sbin/ldconfig -p 2>/dev/null) || ldconfig_cache=
  fi
  missing=
  for library in $required_libraries; do
    library_present "$library" || missing="${missing:+$missing }$library"
  done
}

plan_library_install() {
  manager=
  packages=
  for candidate in apt-get dnf yum zypper pacman; do
    if [ -z "$manager" ] && command -v "$candidate" >/dev/null 2>&1; then
      manager=$candidate
    fi
  done
  [ -n "$manager" ] || return 1
  for library in $missing; do
    library_package "$manager" "$library"
    [ -n "$package" ] || return 1
    packages="${packages:+$packages }$package"
  done
  case "$manager" in
    zypper) install_args="--non-interactive install $packages" ;;
    pacman) install_args="-S --noconfirm --needed $packages" ;;
    *) install_args="install -y $packages" ;;
  esac
}

# REVO_TEST_TTY (test-only) lets tests stand in for the terminal; under `curl | sh` stdin is the script, so
# questions go to the controlling terminal.
has_terminal() {
  terminal=${REVO_TEST_TTY:-/dev/tty}
  (: <"$terminal") 2>/dev/null && (: >>"$terminal") 2>/dev/null
}

confirm() {
  printf 'Run it now? [Y/n] ' >>"$terminal"
  # End of input (Ctrl-D, a closed terminal) is a refusal; only a typed empty line means yes.
  read -r answer <"$terminal" || return 1
  case "$answer" in '' | [Yy]*) return 0 ;; *) return 1 ;; esac
}

run_as_admin() {
  if [ -n "$sudo_prefix" ]; then sudo "$@"; else "$@"; fi
}

# shellcheck disable=SC2086 # install_args holds several words.
install_libraries() {
  if [ "$manager" != apt-get ]; then
    run_as_admin "$manager" $install_args && return
    fail "\`$command_text\` failed; fix that and run the installer again."
  fi
  # The messages are matched below, so apt must speak English whatever the user's locale is.
  output=$(run_as_admin env LC_ALL=C LANG=C "$manager" $install_args 2>&1) && return
  # Refresh the lists only when that is the failure: a fresh apt image has none.
  case "$output" in
    *'Unable to locate package'* | *'has no installation candidate'*)
      say 'Refreshing the package lists...'
      run_as_admin env LC_ALL=C LANG=C apt-get update &&
        run_as_admin env LC_ALL=C LANG=C "$manager" $install_args && return
      ;;
    *) printf '%s\n' "$output" >&2 ;;
  esac
  fail "\`$command_text\` failed; fix that and run the installer again."
}

# Runs before anything is downloaded or created, so declining leaves the machine unchanged.
ensure_system_libraries() {
  [ "$system" = Linux ] || return 0
  find_missing_libraries
  [ -n "$missing" ] || return 0
  needs="Node.js needs $missing, which is missing"
  plan_library_install || fail "$needs; install the package that provides it and run the installer again."
  sudo_prefix=
  if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null 2>&1 ||
      fail "$needs; install it as root with \`$manager $install_args\` and run the installer again."
    sudo_prefix='sudo '
  fi
  command_text="$sudo_prefix$manager $install_args"
  if [ "${REVO_INSTALL_SYSTEM_DEPS:-}" = 1 ] || [ -z "$sudo_prefix" ]; then
    say "$needs. Running: $command_text"
  elif has_terminal; then
    say "$needs."
    say "The installer will run: $command_text"
    confirm || fail "$needs; install it with \`$command_text\` and run the installer again."
  else
    fail "$needs; install it with \`$command_text\` and run the installer again, or run the installer with REVO_INSTALL_SYSTEM_DEPS=1 to let it do that."
  fi
  install_libraries
  find_missing_libraries
  [ -z "$missing" ] || fail "$needs even after \`$command_text\`; install it and run the installer again."
}

locate_installation() {
  [ -n "${HOME:-}" ] || fail 'HOME is not set.'
  install_root=${REVO_INSTALL_ROOT:-$HOME/.local/share/revo-install}
  case "$install_root" in /*) ;; *) fail 'REVO_INSTALL_ROOT must be an absolute path.' ;; esac
  channel_root=$install_root/$channel
  node_home=$channel_root/node/$node_version
  pnpm_home=$channel_root/pnpm/$pnpm_version
  version_home=$channel_root/versions/$version
  staging=$channel_root/.staging
  lock=$channel_root/.lock
  takeover=$lock.takeover
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

# Creates the file with this installer's pid only if it does not exist. The noclobber redirection is
# an O_EXCL open by the shell itself; mkdir is not exclusive in every coreutils (uutils 0.8).
create_with_pid() {
  set -C
  { printf '%s\n' "$$" >"$1"; } 2>/dev/null
  created=$?
  set +C
  return "$created"
}

take_over_stale_lock() {
  owner=$(cat "$lock" 2>/dev/null) || owner=
  if [ -n "$owner" ]; then
    ! kill -0 "$owner" 2>/dev/null || fail "another installation of $product is running (pid $owner)."
  elif [ -e "$lock" ]; then
    fail "another installation of $product is running; if it is not, remove $lock and run the installer again."
  fi
  create_with_pid "$takeover" ||
    fail "another installation of $product may be running; if it is not, remove $takeover and run the installer again."
  takeover_held=1
  if [ -n "$owner" ] && [ "$(cat "$lock" 2>/dev/null)" = "$owner" ]; then
    rm -f "$lock"
  fi
  create_with_pid "$lock"
  taken=$?
  rm -f "$takeover"
  takeover_held=0
  [ "$taken" -eq 0 ] || fail "another installation of $product started at the same time."
}

acquire_lock() {
  mkdir -p "$channel_root" || fail "cannot create $channel_root."
  create_with_pid "$lock" || take_over_stale_lock
  lock_held=1
  rm -rf "$staging" || fail "cannot remove $staging."
  mkdir "$staging" || fail "cannot create $staging."
}

cleanup() {
  [ "$takeover_held" = 0 ] || rm -f "$takeover"
  [ "$lock_held" = 0 ] || rm -rf "$staging" "$lock"
}

interrupted() {
  outcome='the active version is unchanged'
  [ "$activated" = 0 ] || outcome="$product $version is active"
  printf '%s install: interrupted; %s, run the installer again.\n' "$command_name" "$outcome" >&2
  exit "$1"
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
  curl_error=$(curl --fail --location --proto '=https' --proto-redir '=https' --retry 6 --retry-max-time 120 \
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

# Safety net behind the early library check: shows the loader's own error line.
check_runs() {
  expected=$1 description=$2
  shift 2
  found=$(cd / && "$@" 2>"$staging/probe.err") && [ "$found" = "$expected" ] && return
  detail=$(tail -n 1 "$staging/probe.err" 2>/dev/null)
  [ -z "$detail" ] || fail "$description does not run on this machine: $detail"
  fail "$description does not run on this machine."
}

install_toolchain() {
  if [ -f "$staging/node.tar.gz" ]; then
    unpack "$staging/node.tar.gz" "$staging/node" --strip-components=1
    check_runs "v$node_version" "Node.js $node_version" "$staging/node/bin/node" --version
    publish "$staging/node" "$node_home"
  fi
  if [ -f "$staging/pnpm.tar.gz" ]; then
    unpack "$staging/pnpm.tar.gz" "$staging/pnpm"
    check_runs "$pnpm_version" "pnpm $pnpm_version" "$staging/pnpm/pnpm" --version
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
REVO_LAUNCHER_CHANNEL=$channel
export REVO_LAUNCHER_CHANNEL
exec $(quoted "$node_home/bin/node") $(quoted "$version_home/dist/bin/revo.js") "\$@"
EOF
  chmod 755 "$1/bin/$command_name"
}

# The release decides which packages are installed for its private Node.js, how they are linked and
# which build scripts run; these flags override user pnpm settings that would change that. Registry,
# proxy and auth still apply.
install_dependencies() {
  pnpm_data=$channel_root/pnpm-data
  (cd "$revo" && PATH="$node_home/bin:$PATH" PNPM_HOME="$pnpm_data/home" "$pnpm_home/pnpm" install \
    --prod --frozen-lockfile --trust-lockfile --ignore-pnpmfile --os=current --cpu=current --libc=current \
    --store-dir "$pnpm_data/store" --state-dir "$pnpm_data/state" --config.cache-dir="$pnpm_data/cache" \
    --config.offline=false --config.lockfile-dir=. --config.optional=true --config.ignore-scripts=false \
    --config.engine-strict=false --config.dangerously-allow-all-builds=false --config.node-linker=isolated \
    --config.symlink=true --config.modules-dir=node_modules --config.enable-modules-dir=true \
    --config.virtual-store-only=false --config.virtual-store-dir=node_modules/.pnpm --config.virtual-store-type=project)
}

install_revo() {
  revo=$staging/revo
  unpack "$staging/revo.tgz" "$revo" --strip-components=1
  cp "$staging/pnpm-lock.yaml" "$staging/pnpm-workspace.yaml" "$revo/" || fail "cannot prepare $revo."
  say "Installing $product dependencies..."
  install_dependencies || fail 'dependency installation failed; run the installer again.'
  write_launcher "$revo" || fail "cannot create the $command_name launcher."
  publish "$revo" "$version_home"
}

activate_version() {
  ln -s "versions/$version" "$staging/current" || fail "cannot link $product $version."
  "$node_home/bin/node" -e 'require("fs").renameSync(process.argv[1], process.argv[2])' \
    "$staging/current" "$channel_root/current" || fail "cannot switch to $product $version."
  activated=1
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
  lock_held=0 takeover_held=0 activated=0
  define_release
  trap cleanup EXIT
  trap 'interrupted 129' HUP
  trap 'interrupted 130' INT
  trap 'interrupted 143' TERM
  detect_platform
  require_tools
  locate_installation
  check_command_link
  ensure_system_libraries
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
