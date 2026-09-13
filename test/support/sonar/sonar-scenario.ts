import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface SonarRunResult {
  readonly requests: readonly string[];
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

type Scope =
  | { readonly kind: 'branch'; readonly value: string }
  | { readonly kind: 'pullRequest'; readonly value: string };

export class SonarIssuesScenario {
  private analysisResponse = '{"analyses":[{"revision":"expected-revision"}]}';
  private issueResponse = '{"issues":[],"total":0,"paging":{"total":0}}';
  private scope: Scope = { kind: 'branch', value: 'feature/sonar' };
  private token: string | undefined = 'test-token';
  private transportExit = 0;

  static branch(): SonarIssuesScenario {
    return new SonarIssuesScenario();
  }

  static pullRequest(key = '42'): SonarIssuesScenario {
    const scenario = new SonarIssuesScenario();
    scenario.scope = { kind: 'pullRequest', value: key };
    scenario.analysisResponse = JSON.stringify({
      pullRequests: [{ commit: { sha: 'expected-revision' }, key }],
    });

    return scenario;
  }

  withAnalysisResponse(response: unknown): this {
    this.analysisResponse = this.serialize(response);

    return this;
  }

  withIssueResponse(response: unknown): this {
    this.issueResponse = this.serialize(response);

    return this;
  }

  withoutToken(): this {
    this.token = undefined;

    return this;
  }

  withTransportFailure(): this {
    this.transportExit = 22;

    return this;
  }

  async run(): Promise<SonarRunResult> {
    const fixture = await mkdtemp(join(tmpdir(), 'revo-sonar-'));
    const fakeCurl = join(fixture, 'curl');
    const requestLog = join(fixture, 'requests.log');
    const analysisFile = join(fixture, 'analysis.json');
    const issueFile = join(fixture, 'issues.json');
    await Promise.all([
      writeFile(analysisFile, this.analysisResponse),
      writeFile(issueFile, this.issueResponse),
      writeFile(
        fakeCurl,
        `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$SONAR_FIXTURE_REQUEST_LOG"
if [ "$SONAR_FIXTURE_TRANSPORT_EXIT" -ne 0 ]; then
  exit "$SONAR_FIXTURE_TRANSPORT_EXIT"
fi
case "$*" in
  *'/api/issues/search'*) cat "$SONAR_FIXTURE_ISSUES" ;;
  *) cat "$SONAR_FIXTURE_ANALYSIS" ;;
esac
`,
      ),
    ]);
    await chmod(fakeCurl, 0o755);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fixture}:${process.env.PATH ?? ''}`,
      SONAR_EXPECTED_REVISION: 'expected-revision',
      SONAR_FIXTURE_ANALYSIS: analysisFile,
      SONAR_FIXTURE_ISSUES: issueFile,
      SONAR_FIXTURE_REQUEST_LOG: requestLog,
      SONAR_FIXTURE_TRANSPORT_EXIT: String(this.transportExit),
      SONAR_HOST_URL: 'https://sonar.invalid',
      SONAR_ENV_FILE: join(fixture, 'absent.env'),
    };
    delete env.GITHUB_EVENT_NAME;
    delete env.GITHUB_EVENT_PATH;
    if (this.token === undefined) {
      delete env.SONAR_TOKEN;
    } else {
      env.SONAR_TOKEN = this.token;
    }
    if (this.scope.kind === 'pullRequest') {
      env.SONAR_PR_KEY = this.scope.value;
      delete env.SONAR_BRANCH_NAME;
    } else {
      env.SONAR_BRANCH_NAME = this.scope.value;
      delete env.SONAR_PR_KEY;
    }

    const result = spawnSync('bash', [resolve('scripts/sonar-issues-local.sh')], {
      cwd: resolve('.'),
      encoding: 'utf8',
      env,
    });
    const requests = await readFile(requestLog, 'utf8').catch(() => '');
    await rm(fixture, { force: true, recursive: true });

    return {
      requests: requests.trim() === '' ? [] : requests.trim().split('\n'),
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }

  private serialize(response: unknown): string {
    return typeof response === 'string' ? response : JSON.stringify(response);
  }
}
