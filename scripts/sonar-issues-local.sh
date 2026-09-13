#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SONAR_ENV_FILE="${SONAR_ENV_FILE:-.env.sonar}"
if [[ -f "$SONAR_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SONAR_ENV_FILE"
  set +a
fi

SONAR_HOST_URL="${SONAR_HOST_URL:-https://sonarcloud.io}"
if [[ -z "${SONAR_TOKEN:-}" ]]; then
  echo "SONAR_TOKEN is required; an unavailable Sonar provider cannot pass." >&2
  exit 1
fi

PROJECT_KEY="$(sed -n 's/^sonar.projectKey=//p' sonar-project.properties | head -n 1)"
if [[ -z "$PROJECT_KEY" ]]; then
  echo "sonar.projectKey was not found in sonar-project.properties." >&2
  exit 1
fi

EXPECTED_REVISION="${SONAR_EXPECTED_REVISION:-$(git rev-parse HEAD)}"
scope_kind=branch
scope_value=""
if [[ -n "${SONAR_PR_KEY:-}" ]]; then
  scope_kind=pullRequest
  scope_value="$SONAR_PR_KEY"
elif [[ "${GITHUB_EVENT_NAME:-}" == pull_request* && -f "${GITHUB_EVENT_PATH:-}" ]]; then
  scope_kind=pullRequest
  scope_value="$(node -e "const fs = require('node:fs'); console.log(JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request.number)")"
elif [[ -n "${SONAR_BRANCH_NAME:-}" ]]; then
  scope_value="$SONAR_BRANCH_NAME"
elif command -v gh >/dev/null 2>&1 && pr_json="$(gh pr view --json number 2>/dev/null)"; then
  scope_kind=pullRequest
  scope_value="$(node -e "console.log(JSON.parse(process.argv[1]).number)" "$pr_json")"
else
  scope_value="$(git rev-parse --abbrev-ref HEAD)"
fi
scope_args=(--data-urlencode "${scope_kind}=${scope_value}")

if [[ "$scope_kind" == pullRequest ]]; then
  analysis_url="${SONAR_HOST_URL}/api/project_pull_requests/list"
  analysis_args=(--data-urlencode "project=${PROJECT_KEY}")
else
  analysis_url="${SONAR_HOST_URL}/api/project_analyses/search"
  analysis_args=(--data-urlencode "project=${PROJECT_KEY}" --data-urlencode "ps=1" "${scope_args[@]}")
fi

if ! analysis_response="$(curl -fsS -u "${SONAR_TOKEN}:" --get "$analysis_url" "${analysis_args[@]}")"; then
  echo "Authenticated Sonar analysis query failed; provider status is unavailable." >&2
  exit 1
fi

node - "$scope_kind" "$scope_value" "$EXPECTED_REVISION" "$analysis_response" <<'NODE'
const [scopeKind, scopeValue, expectedRevision, source] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(source);
} catch {
  fail('Sonar analysis response was not valid JSON.');
}
if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
  fail('Sonar analysis response had an invalid schema.');
}

let actualRevision;
if (scopeKind === 'pullRequest') {
  if (!Array.isArray(payload.pullRequests)) {
    fail('Sonar pull request response had an invalid schema.');
  }
  const analysis = payload.pullRequests.find((entry) => String(entry?.key) === scopeValue);
  actualRevision = analysis?.commit?.sha;
  if (analysis === undefined) {
    fail(`Sonar pull request ${scopeValue} analysis was not found.`);
  }
} else {
  if (!Array.isArray(payload.analyses) || payload.analyses.length === 0) {
    fail(`Sonar branch ${scopeValue} analysis was not found.`);
  }
  actualRevision = payload.analyses[0]?.revision;
}
if (typeof actualRevision !== 'string' || actualRevision !== expectedRevision) {
  fail(`Sonar analysis revision mismatch: expected ${expectedRevision}, received ${actualRevision ?? 'none'}.`);
}
console.log(`Sonar analysis revision: ${actualRevision}`);
NODE

if ! issue_response="$(curl -fsS -u "${SONAR_TOKEN}:" --get "${SONAR_HOST_URL}/api/issues/search" \
  --data-urlencode "componentKeys=${PROJECT_KEY}" \
  --data-urlencode "issueStatuses=OPEN" \
  --data-urlencode "ps=500" \
  "${scope_args[@]}")"; then
  echo "Authenticated Sonar issue query failed; provider status is unavailable." >&2
  exit 1
fi

node - "$issue_response" <<'NODE'
const [source] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(source);
} catch {
  fail('Sonar issue response was not valid JSON.');
}
const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
if (
  payload === null ||
  typeof payload !== 'object' ||
  Array.isArray(payload) ||
  !Array.isArray(payload.issues) ||
  !validCount(payload.total) ||
  payload.paging === null ||
  typeof payload.paging !== 'object' ||
  Array.isArray(payload.paging) ||
  !validCount(payload.paging.total) ||
  payload.total !== payload.paging.total
) {
  fail('Sonar issue response had an invalid total, paging total, or issues schema.');
}
if (payload.total === 0 && payload.issues.length !== 0) {
  fail('Sonar issue response contradicted its zero total.');
}
if (payload.total === 0) {
  console.log('Sonar open issues: 0');
  process.exit(0);
}

console.error(`Sonar open issues: ${payload.total}`);
for (const issue of payload.issues.slice(0, 50)) {
  const component = String(issue?.component ?? '').replace(/^[^:]+:/u, '');
  const line = issue?.line === undefined ? '' : `:${issue.line}`;
  console.error(`- ${component}${line} ${issue?.rule ?? ''} ${issue?.severity ?? ''}: ${issue?.message ?? ''}`);
}
process.exit(1);
NODE
