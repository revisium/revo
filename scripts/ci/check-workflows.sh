#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly version='1.7.12'
readonly archive_sha256='8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8'
readonly archive_url="https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz"
if ! temporary_directory="$(mktemp -d)"; then
  printf 'Could not create a private actionlint directory\n' >&2
  exit 1
fi
if [[ -z "$temporary_directory" || ! -d "$temporary_directory" ]]; then
  printf 'mktemp did not create an actionlint directory\n' >&2
  exit 1
fi
readonly temporary_directory
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

readonly archive_path="$temporary_directory/actionlint.tar.gz"
readonly executable_path="$temporary_directory/actionlint"
curl --fail --location --silent --show-error \
  --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 90 \
  "$archive_url" --output "$archive_path"
printf '%s  %s\n' "$archive_sha256" "$archive_path" | sha256sum --check --status
tar --extract --gzip --to-stdout --file "$archive_path" actionlint >"$executable_path"
chmod 700 "$executable_path"

version_output="$("$executable_path" -version)"
if [[ "$version_output" != *"${version}"* ]]; then
  printf 'Unexpected actionlint version: %s\n' "$version_output" >&2
  exit 1
fi

readonly workflows=(
  .github/workflows/ci.yml
  .github/workflows/release-acceptance.yml
)
"$executable_path" -shellcheck= -pyflakes= "${workflows[@]}"

# Prove that this pinned validator rejects runner context in jobs.<job_id>.env.
python3 - "${workflows[1]}" "$temporary_directory/invalid-runner-context.yml" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
consumer = source.find("\n  consumer:\n")
if consumer < 0:
    raise SystemExit("consumer job is missing")
env = source.find("\n    env:\n", consumer)
if env < 0:
    raise SystemExit("consumer job env is missing")
insertion = env + len("\n    env:\n")
mutated = source[:insertion] + "      INVALID_RUNNER_TEMP: ${{ runner.temp }}\n" + source[insertion:]
Path(sys.argv[2]).write_text(mutated)
PY

if "$executable_path" -shellcheck= -pyflakes= "$temporary_directory/invalid-runner-context.yml" \
  >"$temporary_directory/negative.output" 2>&1; then
  printf 'actionlint accepted runner.temp in jobs.consumer.env\n' >&2
  exit 1
fi
negative_diagnostic="$(sed -E 's#^[^:]+:[0-9]+:[0-9]+: ##' "$temporary_directory/negative.output")"
if ! grep -Eiq 'runner.*context|context.*runner' <<<"$negative_diagnostic"; then
  printf 'actionlint rejected the negative fixture for an unexpected reason:\n' >&2
  printf '%s\n' "$negative_diagnostic" >&2
  exit 1
fi
