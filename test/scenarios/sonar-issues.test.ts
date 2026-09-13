import { describe, expect, it } from 'vitest';

import { SonarIssuesScenario } from '../support/sonar/sonar-scenario.js';

describe('Sonar issue inspection', () => {
  it('accepts an issue-free analysis of the exact branch revision', async () => {
    const result = await SonarIssuesScenario.branch().run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Sonar analysis revision: expected-revision');
    expect(result.stdout).toContain('Sonar open issues: 0');
    expect(result.requests).toHaveLength(2);
    expect(result.requests.every((request) => request.includes('branch=feature/sonar'))).toBe(true);
  });

  it('uses the pull request scope for both analysis and issues', async () => {
    const result = await SonarIssuesScenario.pullRequest('73').run();

    expect(result.status).toBe(0);
    expect(result.requests[0]).toContain('/api/project_pull_requests/list');
    expect(result.requests[1]).toContain('pullRequest=73');
  });

  it('rejects a stale analysis revision', async () => {
    const result = await SonarIssuesScenario.branch()
      .withAnalysisResponse({ analyses: [{ revision: 'stale-revision' }] })
      .run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('revision mismatch');
    expect(result.requests).toHaveLength(1);
  });

  it('rejects a missing scoped analysis', async () => {
    const result = await SonarIssuesScenario.pullRequest()
      .withAnalysisResponse({ pullRequests: [] })
      .run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('analysis was not found');
  });

  it.each([
    ['invalid JSON', '{'],
    ['missing issues', { total: 0, paging: { total: 0 } }],
    ['missing total', { issues: [], paging: { total: 0 } }],
    ['missing paging total', { issues: [], total: 0, paging: {} }],
    ['inconsistent totals', { issues: [], total: 0, paging: { total: 1 } }],
  ])('rejects an HTTP 200 issue response with %s', async (_case, response) => {
    const result = await SonarIssuesScenario.branch().withIssueResponse(response).run();

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/valid JSON|invalid total/);
  });

  it('fails when Sonar reports open issues even if the first page is empty', async () => {
    const result = await SonarIssuesScenario.branch()
      .withIssueResponse({ issues: [], total: 501, paging: { total: 501 } })
      .run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Sonar open issues: 501');
  });

  it('fails closed when the token is absent', async () => {
    const result = await SonarIssuesScenario.branch().withoutToken().run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SONAR_TOKEN is required');
    expect(result.requests).toHaveLength(0);
  });

  it('fails closed on transport or authentication errors', async () => {
    const result = await SonarIssuesScenario.branch().withTransportFailure().run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('provider status is unavailable');
  });
});
