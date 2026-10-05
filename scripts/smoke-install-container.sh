#!/bin/sh
# Runs as root inside a minimal Debian or Ubuntu container. It checks what the installer does when
# libatomic1 is missing, then runs the full smoke install as a non-root user with passwordless sudo.
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

apt-get update -qq
apt-get install -y -qq --no-install-recommends curl ca-certificates
# Only the smoke harness needs these; the installer does not.
apt-get install -y -qq --no-install-recommends sudo python3 openssl
# A minimal image has no package lists, so the installer has to refresh them itself.
rm -rf /var/lib/apt/lists/*
if ldconfig -p | grep -q 'libatomic\.so\.1'; then
  fail 'the image already has libatomic.so.1'
fi
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
if output=$(su -s /bin/sh revo -c "sh '$script' </dev/null" 2>&1); then
  fail 'the installer succeeded without libatomic.so.1'
fi
printf '%s\n' "$output"
case "$output" in
  *"\`sudo apt-get install -y libatomic1\`"*REVO_INSTALL_SYSTEM_DEPS=1*) ;;
  *) fail 'the installer did not show the command and the opt-in' ;;
esac
if dpkg -s libatomic1 >/dev/null 2>&1; then
  fail 'the installer installed libatomic1 without being allowed to'
fi
[ ! -e /home/revo/.local ] || fail 'the installer changed the home directory without being allowed to'
printf 'container smoke: the missing library was reported and nothing changed\n'

su -s /bin/sh revo -c "REVO_INSTALL_SYSTEM_DEPS=1 sh /work/smoke-install.sh --bundle '$bundle'"
dpkg -s libatomic1 >/dev/null 2>&1 || fail 'the installer did not install libatomic1'
printf 'container smoke: passed\n'
