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

# Per package manager: the harness packages, how the installer installs the library, and how to ask whether
# the library is installed. curl is added only when the image lacks it (Fedora and Amazon Linux ship curl-minimal).
for manager in apt-get dnf zypper pacman; do
  command -v "$manager" >/dev/null 2>&1 && break
done
case "$manager" in
  apt-get)
    refresh='apt-get update -qq'
    install='apt-get install -y -qq --no-install-recommends'
    tools='ca-certificates sudo python3 openssl'
    expected='sudo apt-get install -y libatomic1'
    package=libatomic1
    installed() { dpkg -s libatomic1 >/dev/null 2>&1; }
    ;;
  dnf)
    refresh=:
    install='dnf install -y -q --setopt=timeout=30'
    tools='ca-certificates sudo python3 openssl shadow-utils util-linux tar gzip'
    expected='sudo dnf install -y libatomic'
    package=libatomic
    installed() { rpm -q libatomic >/dev/null 2>&1; }
    ;;
  zypper)
    refresh='zypper --non-interactive --quiet refresh'
    install='zypper --non-interactive --quiet install --no-recommends'
    # The default python3 of Leap is 3.6, too old for the smoke harness.
    tools='ca-certificates sudo python311 openssl shadow util-linux tar gzip'
    after='ln -sf /usr/bin/python3.11 /usr/bin/python3'
    expected='sudo zypper --non-interactive install libatomic1'
    package=libatomic1
    installed() { rpm -q libatomic1 >/dev/null 2>&1; }
    ;;
  pacman)
    refresh='pacman -Sy --noconfirm'
    install='pacman -S --noconfirm --needed'
    tools='ca-certificates sudo python openssl'
    expected='sudo pacman -S --noconfirm --needed gcc-libs'
    package=gcc-libs
    installed() { pacman -Q gcc-libs >/dev/null 2>&1; }
    ;;
  *) fail 'the image has no supported package manager' ;;
esac
$refresh
command -v curl >/dev/null 2>&1 || tools="curl $tools"
# shellcheck disable=SC2086 # tools holds several words.
$install $tools
${after:-:}
# A minimal Debian image has no package lists, so the installer has to refresh them itself.
if [ "$manager" = apt-get ]; then rm -rf /var/lib/apt/lists/*; fi

# Some images (openSUSE) put an empty .local into new homes, so look for what the installer creates.
no_installation() { [ ! -e /home/revo/.local/bin ] && [ ! -e /home/revo/.local/share/revo-install ]; }
useradd --create-home --shell /bin/sh revo
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
    no_installation || fail 'the installer changed the home directory on an unsupported system'
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
no_installation || fail 'the installer changed the home directory without being allowed to'
printf 'container smoke: the missing library was reported and nothing changed\n'

su -s /bin/sh revo -c "REVO_INSTALL_SYSTEM_DEPS=1 sh /work/smoke-install.sh --bundle '$bundle'"
installed || fail "the installer did not install $package"
printf 'container smoke: passed\n'
