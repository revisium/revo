#!/bin/sh
# Runs as root inside a minimal Linux container. It checks what the installer does when
# libatomic is missing, then runs the full smoke install as a non-root user with passwordless sudo.
# Usage: scripts/smoke-install-container.sh <bundle directory>
set -eu

fail() {
  printf 'container smoke: FAILED: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail 'usage: smoke-install-container.sh <bundle directory>'
[ "$(id -u)" -eq 0 ] || fail 'run it as root in a container'
bundle=$(cd "$1" && pwd)
repo=$(cd "$(dirname "$0")/.." && pwd)
export DEBIAN_FRONTEND=noninteractive

# Per package manager: the harness packages, how the installer installs what is missing, and how to ask whether
# the library is installed. curl is added only when the image lacks it (Fedora and Amazon Linux ship curl-minimal).
# The rpm images lose tar and gzip after the setup, as the smallest images lack them, so the installer has to
# install them together with the library.
manager=
for candidate in apt-get dnf zypper pacman; do
  if command -v "$candidate" >/dev/null 2>&1; then
    manager=$candidate
    break
  fi
done
strip() { :; }
case "$manager" in
  apt-get)
    refresh='apt-get update -qq'
    install='apt-get install -y -qq --no-install-recommends'
    tools='ca-certificates sudo python3 openssl'
    command_prefix='sudo apt-get install -y'
    package=libatomic1
    installed() { dpkg -s libatomic1 >/dev/null 2>&1; }
    ;;
  dnf)
    refresh=:
    install='dnf install -y -q --setopt=timeout=30'
    tools='ca-certificates sudo python3 openssl shadow-utils util-linux findutils'
    strip() { rpm -e --nodeps tar gzip 2>/dev/null || :; }
    command_prefix='sudo dnf install -y'
    package=libatomic
    installed() { rpm -q libatomic >/dev/null 2>&1; }
    ;;
  zypper)
    refresh='zypper --non-interactive --quiet refresh'
    install='zypper --non-interactive --quiet install --no-recommends'
    tools='ca-certificates sudo python3 openssl shadow util-linux findutils'
    strip() { rpm -e --nodeps tar gzip 2>/dev/null || :; }
    command_prefix='sudo zypper --non-interactive install'
    package=libatomic1
    installed() { rpm -q libatomic1 >/dev/null 2>&1; }
    ;;
  pacman)
    refresh='pacman -Sy --noconfirm'
    install='pacman -S --noconfirm --needed'
    tools='ca-certificates sudo python openssl'
    command_prefix='sudo pacman -S --noconfirm --needed'
    package=gcc-libs
    installed() { pacman -Q gcc-libs >/dev/null 2>&1; }
    ;;
  *) fail 'the image has no supported package manager' ;;
esac
$refresh
command -v curl >/dev/null 2>&1 || tools="curl $tools"
# shellcheck disable=SC2086 # tools holds several words.
$install $tools
strip
# A minimal Debian image has no package lists, so the installer has to refresh them itself.
if [ "$manager" = apt-get ]; then rm -rf /var/lib/apt/lists/*; fi

missing_tools=
for tool in tar gzip; do
  command -v "$tool" >/dev/null 2>&1 || missing_tools="$missing_tools$tool "
done
expected="$command_prefix $missing_tools$package"

# Everything the installer or a refused install could touch. Some images put files into new homes.
useradd --create-home --shell /bin/sh revo
snapshot() { command -v find >/dev/null || fail "find is missing"; find /home/revo /usr/local -printf '%p %y %m %s\n' | sort; }
before=$(snapshot)
printf 'revo ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/revo
chmod 440 /etc/sudoers.d/revo
# The mounts can be unreadable for the new user, so it works on copies it owns.
install -d -o revo -g revo /work
cp -R "$bundle" /work/bundle
cp "$repo/scripts/smoke-install.sh" /work/smoke-install.sh
chown -R revo:revo /work
bundle=/work/bundle
script=$(ls "$bundle"/install*.sh)

# Below the glibc floor the installer has to refuse before it touches anything.
glibc=$(getconf GNU_LIBC_VERSION)
case "${glibc#glibc }" in
  2.[0-9] | 2.[12][0-9] | 2.3[0-4])
    if output=$(su -s /bin/sh revo -c "sh '$script' </dev/null" 2>&1); then
      fail "the installer succeeded on $glibc"
    fi
    printf '%s\n' "$output"
    case "$output" in
      *"unsupported platform ($glibc)"*) ;;
      *) fail "the installer did not refuse $glibc clearly" ;;
    esac
    [ "$(snapshot)" = "$before" ] || fail 'the installer changed the machine on an unsupported system'
    printf 'container smoke: %s is refused cleanly and nothing changed\n' "$glibc"
    exit 0
    ;;
  *) ;;
esac

if ldconfig -p | grep -q 'libatomic\.so\.1'; then
  # Arch ships libatomic.so.1 in gcc-libs, which cannot be removed, so there is nothing to install.
  [ "$manager" = pacman ] || fail 'the image already has libatomic.so.1'
  printf 'container smoke: libatomic.so.1 is part of the base image, so only the full smoke runs\n'
  su -s /bin/sh revo -c "sh /work/smoke-install.sh --bundle '$bundle'"
  printf 'container smoke: passed\n'
  exit 0
fi

if output=$(su -s /bin/sh revo -c "sh '$script' </dev/null" 2>&1); then
  fail 'the installer succeeded without libatomic.so.1'
fi
printf '%s\n' "$output"
case "$output" in
  *"\`$expected\`"*REVO_INSTALL_SYSTEM_DEPS=1*) ;;
  *) fail "the installer did not show \`$expected\` and the opt-in" ;;
esac
if installed; then
  fail "the installer installed $package without being allowed to"
fi
[ "$(snapshot)" = "$before" ] || fail 'the installer changed the machine without being allowed to'
for tool in $missing_tools; do
  ! command -v "$tool" >/dev/null 2>&1 || fail "the installer installed $tool without being allowed to"
done
printf 'container smoke: the missing library was reported and nothing changed\n'

su -s /bin/sh revo -c "REVO_INSTALL_SYSTEM_DEPS=1 sh /work/smoke-install.sh --bundle '$bundle'"
installed || fail "the installer did not install $package"
for tool in $missing_tools; do
  command -v "$tool" >/dev/null 2>&1 || fail "the installer did not install $tool"
done
printf 'container smoke: passed\n'
