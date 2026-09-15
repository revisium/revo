import { describe, expect, it } from 'vitest';

import {
  PACKAGE_INSTALL_PLAN_SCHEMA,
  createPackageInstallPlan,
  parsePackageInstallPlan,
} from '../../src/installation/package-install-plan.js';
import { packageReleaseFixture } from '../support/installation/package-release-fixture.js';

describe('immutable package install plan', () => {
  it('pins the generic release, components, four artifacts, target, and toolchain', () => {
    const fixture = packageReleaseFixture({
      channel: 'alpha',
      version: '7.8.9-alpha.2',
      versions: {
        core: '8.7.6-beta.2',
        admin: '9.8.7+build.4',
        node: '30.0.0-rc.1',
        pnpm: '14.2.1',
      },
    });
    const plan = createPackageInstallPlan({ manifest: fixture.manifest, request: fixture.request });
    expect(plan.schemaVersion).toBe(PACKAGE_INSTALL_PLAN_SCHEMA);
    expect(plan.release).toEqual(fixture.manifest.release);
    expect(plan.components).toEqual(fixture.manifest.components);
    expect(plan.artifacts).toEqual(fixture.manifest.artifacts);
    expect(plan.target).toEqual(fixture.request.target);
    expect(plan.toolchain).toEqual(fixture.request.toolchain);
  });

  it('copies immutable data and rejects request or re-resolution mismatches', () => {
    const fixture = packageReleaseFixture();
    const plan = createPackageInstallPlan(fixture.manifest, fixture.request);
    (fixture.manifest.artifacts.package as { url: string }).url = 'https://moving.invalid';
    expect(plan.artifacts.package.url).not.toBe('https://moving.invalid');
    expect(() =>
      createPackageInstallPlan(fixture.manifest, {
        ...fixture.request,
        toolchain: { ...fixture.request.toolchain, pnpm: '99.1.1' },
      }),
    ).toThrow(/toolchain|match/iu);
    expect(() =>
      createPackageInstallPlan(fixture.manifest, {
        ...fixture.request,
        release: { ...fixture.request.release, version: '9.9.9' },
      }),
    ).toThrow(/release|match/iu);
  });

  it('round-trips a plan through its separate versioned envelope', () => {
    const fixture = packageReleaseFixture();
    const plan = createPackageInstallPlan({ manifest: fixture.manifest, request: fixture.request });
    expect(parsePackageInstallPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(() =>
      parsePackageInstallPlan({ ...plan, schemaVersion: 'revo-node-bootstrap/v1' }),
    ).toThrow(/schema/iu);
  });
});
