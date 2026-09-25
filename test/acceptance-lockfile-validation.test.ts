import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parseAllDocuments, stringify } from 'yaml';

import {
  validateTuiLockOverride,
  validateTuiLockSource,
} from '../scripts/acceptance/lockfile-validation.mjs';

// oxlint-disable vitest/expect-expect -- error assertions are centralized in expectErrorCode.

const NAME = '@revisium/revo-tui';
const SOURCE_VERSION = '0.1.0-alpha.1';
const TARBALL_VERSION = '0.0.0';
const TARBALL_SHA256 = '8562690a2a995b0754470604b3ff38c499984ca3d8ab444bab311737cd6a5bd2';
const INTEGRITY =
  'sha512-IrtvF1zYPmu1QE6CVmBWpffQKoCzeYz9BQHDSE8LiSmrGUES/rK3E1EnYiRVWsAj5bZPvAVAJ9pjLMSd4JD1dg==';
const TUI_URL =
  'https://127.0.0.1:18446/tui/8562690a2a995b0754470604b3ff38c499984ca3d8ab444bab311737cd6a5bd2/final-acceptance-revo-tui-0.0.0.tgz?sha256=8562690a2a995b0754470604b3ff38c499984ca3d8ab444bab311737cd6a5bd2';

describe('TUI lockfile override validation', () => {
  it('preserves the byte-for-byte C0 lockfile evidence recorded in provenance', async () => {
    const { before, after } = await c0Fixture();
    const provenance: unknown = JSON.parse(
      await readFile(
        new URL('./fixtures/acceptance-lockfile/pnpm-12.5.1-provenance.json', import.meta.url),
        'utf8',
      ),
    );

    expect(provenance).toMatchObject({
      sourceLockSha256: sha256(before),
      afterLockSha256: sha256(after),
    });
  });

  it('accepts the exact two-document pnpm 12.5.1 HTTPS tarball result', async () => {
    const { before, after } = await c0Fixture();

    const receipt = validateTuiLockOverride({
      beforeLock: before,
      afterLock: after,
      sourcePackage: sourcePackage(),
      stagedPackage: stagedPackage(),
      expected: expectedOverride(),
    });

    expect(receipt).toMatchObject({
      policy: 'revo-tui-lock-override-v1',
      documentCount: 2,
      applicationDocumentIndex: 1,
      importer: '.',
      dependency: NAME,
      sourcePackageKey: `${NAME}@${SOURCE_VERSION}`,
      targetPackageKey: `${NAME}@${TUI_URL}`,
      peerSuffix:
        '(react-devtools-core@7.0.1)(typescript@7.0.2)(web-tree-sitter@0.25.10)(ws@8.21.3)',
      sourceSnapshotKey: `${NAME}@${SOURCE_VERSION}(react-devtools-core@7.0.1)(typescript@7.0.2)(web-tree-sitter@0.25.10)(ws@8.21.3)`,
      targetSnapshotKey: `${NAME}@${TUI_URL}(react-devtools-core@7.0.1)(typescript@7.0.2)(web-tree-sitter@0.25.10)(ws@8.21.3)`,
      url: TUI_URL,
      integrity: INTEGRITY,
      tarballSha256: TARBALL_SHA256,
      version: TARBALL_VERSION,
      sourceLockSha256: sha256(before),
      stagingLockSha256: sha256(after),
    });
  });

  it('preflights the source binding before pnpm and reports the same selected locator', async () => {
    const { before, after } = await c0Fixture();
    const source = validateTuiLockSource({
      sourceLock: before,
      sourcePackage: sourcePackage(),
      expected: expectedOverride(),
    });
    const full = validateTuiLockOverride({
      beforeLock: before,
      afterLock: after,
      sourcePackage: sourcePackage(),
      stagedPackage: stagedPackage(),
      expected: expectedOverride(),
    });
    expect(source).toMatchObject({
      sourceLockSha256: full.sourceLockSha256,
      sourcePackageKey: full.sourcePackageKey,
      sourceSnapshotKey: full.sourceSnapshotKey,
      peerSuffix: full.peerSuffix,
    });
  });

  it('compares parsed structure rather than comments, formatting, or mapping order', async () => {
    const { before, after } = await c0Fixture();

    expect(
      validateTuiLockOverride({
        beforeLock: await reformatAndReverseMaps(before),
        afterLock: await reformatAndReverseMaps(after),
        sourcePackage: sourcePackage(),
        stagedPackage: stagedPackage(),
        expected: expectedOverride(),
      }).policy,
    ).toBe('revo-tui-lock-override-v1');
  });

  it.each([
    [
      'the root importer specifier',
      (application: Map<string, unknown>) => {
        mapAt(application, ['importers', '.', 'dependencies', NAME]).set(
          'specifier',
          SOURCE_VERSION,
        );
      },
    ],
    [
      'the target package integrity',
      (application: Map<string, unknown>) => {
        mapAt(application, ['packages', `${NAME}@${TUI_URL}`, 'resolution']).set(
          'integrity',
          INTEGRITY.replace('Irtv', 'Arxv'),
        );
      },
    ],
    [
      'the target package version',
      (application: Map<string, unknown>) =>
        mapAt(application, ['packages', `${NAME}@${TUI_URL}`]).set('version', '0.0.1'),
    ],
    [
      'the exact root peer suffix',
      (application: Map<string, unknown>) =>
        mapAt(application, ['importers', '.', 'dependencies', NAME]).set(
          'version',
          `${TUI_URL}${peerSuffixFixture().replace('react-devtools-core@7.0.1', 'react-devtools-core@7.0.2')}`,
        ),
    ],
    [
      'an unrelated application setting',
      (application: Map<string, unknown>) =>
        mapAt(application, ['settings']).set('autoInstallPeers', false),
    ],
    [
      'the target package key',
      (application: Map<string, unknown>) =>
        renameMapKey(
          mapAt(application, ['packages']),
          `${NAME}@${TUI_URL}`,
          `@revisium/revo-tui-helper@${TUI_URL}`,
        ),
    ],
  ])('rejects structural bypass at %s', async (_description, mutate) => {
    const documents = await fixturePair();
    mutate(mapAt(documents[1], ['1']));
    const [before, after] = await serializeFixturePair(documents);
    expectErrorCode(() => validateFixturePair(before, after), 'LOCK_DRIFT');
  });

  it('rejects a changed toolchain pnpm pin by profile category', async () => {
    const documents = await fixturePair();
    mapAt(documents[1], ['0', 'importers', '.', 'packageManagerDependencies', 'pnpm']).set(
      'specifier',
      '12.5.2',
    );
    const [before, after] = await serializeFixturePair(documents);
    expectErrorCode(() => validateFixturePair(before, after), 'TOOLCHAIN_BINDING');
  });

  it('rejects drift in the exact TUI snapshot dependency path', async () => {
    const documents = await fixturePair();
    const afterApp = mapAt(documents[1], ['1']);
    const tuiSnapshot = mapAt(afterApp, ['snapshots', `${NAME}@${TUI_URL}${peerSuffixFixture()}`]);
    const dependencies = mapAt(tuiSnapshot, ['dependencies']);
    const previous = dependencies.get('@opentui/core');
    expect(previous).toBe('0.5.11(typescript@7.0.2)(web-tree-sitter@0.25.10)');
    dependencies.set('@opentui/core', '0.5.12(typescript@7.0.2)(web-tree-sitter@0.25.10)');
    const [before, after] = await serializeFixturePair(documents);
    expectErrorCode(() => validateFixturePair(before, after), 'LOCK_DRIFT');
  });

  it.each([
    ['duplicate mapping keys', "lockfileVersion: '9.0'\n", 'YAML_SYNTAX'],
    ['aliases', 'unsafeAnchor: &anchor value\nunsafeAlias: *anchor\n', 'YAML_FEATURE_UNSUPPORTED'],
    [
      'merge keys',
      'unsafeBase: &base {a: value}\nunsafeMerge: {<<: *base}\n',
      'YAML_FEATURE_UNSUPPORTED',
    ],
    ['explicit tags', 'unsafeTag: !!str value\n', 'YAML_FEATURE_UNSUPPORTED'],
    ['complex mapping keys', '? [a, b]\n: value\n', 'LOCK_SCHEMA'],
    ['malformed YAML', 'unsafeList: [unterminated\n', 'YAML_SYNTAX'],
  ])('rejects unsafe YAML in a complete C0 pair: %s', async (_description, fragment, code) => {
    const { before, after } = await c0Fixture();
    const unsafeBefore = injectFirstDocument(before, fragment);
    const unsafeAfter = injectFirstDocument(after, fragment);
    expectErrorCode(
      () =>
        validateTuiLockOverride({
          beforeLock: unsafeBefore,
          afterLock: unsafeAfter,
          sourcePackage: sourcePackage(),
          stagedPackage: stagedPackage(),
          expected: expectedOverride(),
        }),
      code,
    );
  });

  it.each([
    ['one document', Buffer.from("lockfileVersion: '9.0'\n")],
    [
      'three documents',
      Buffer.from(
        "lockfileVersion: '9.0'\n---\nlockfileVersion: '9.0'\n---\nlockfileVersion: '9.0'\n",
      ),
    ],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
    ['oversized input', Buffer.alloc(8 * 1024 * 1024 + 1, 0x20)],
  ])('fails closed for unsupported document input: %s', async (_description, malformed) => {
    const { after } = await c0Fixture();

    expect(() =>
      validateTuiLockOverride({
        beforeLock: malformed,
        afterLock: after,
        sourcePackage: sourcePackage(),
        stagedPackage: stagedPackage(),
        expected: expectedOverride(),
      }),
    ).toThrow(/lockfile|document|UTF-8|size|unsupported/u);
  });

  it('requires the staged package manifest to change only the exact TUI dependency', async () => {
    const { before, after } = await c0Fixture();
    const changedManifest = {
      ...stagedPackage(),
      dependencies: { ...stagedPackage().dependencies, '@nestjs/common': '11.1.27' },
    };

    expect(() =>
      validateTuiLockOverride({
        beforeLock: before,
        afterLock: after,
        sourcePackage: sourcePackage(),
        stagedPackage: changedManifest,
        expected: expectedOverride(),
      }),
    ).toThrow(/package manifest|dependency override/u);
  });

  it('allows the exact package to remain as an unrelated, independently resolved version', async () => {
    const documents = await fixturePair();
    const independentPackage = cloneFixtureValue(
      mapAt(documents[0], ['1', 'packages']).get(`${NAME}@${SOURCE_VERSION}`),
    );
    const independentSnapshot = cloneFixtureValue(
      mapAt(documents[0], ['1', 'snapshots']).get(
        `${NAME}@${SOURCE_VERSION}${peerSuffixFixture()}`,
      ),
    );
    if (!(independentPackage instanceof Map)) {
      throw new Error('fixture TUI package record is not a mapping');
    }
    independentPackage.set('version', '0.2.0');
    for (const document of documents) {
      const application = mapAt(document, ['1']);
      const packages = mapAt(application, ['packages']);
      const snapshots = mapAt(application, ['snapshots']);
      const importer = new Map<string, unknown>();
      const dependencies = new Map<string, unknown>([
        [NAME, { specifier: '0.2.0', version: '0.2.0' }],
      ]);
      importer.set('dependencies', dependencies);
      mapAt(application, ['importers']).set('other-consumer', importer);
      packages.set(`${NAME}@0.2.0`, cloneFixtureValue(independentPackage));
      snapshots.set(`${NAME}@0.2.0`, cloneFixtureValue(independentSnapshot));
    }
    const [before, after] = await serializeFixturePair(documents);
    expect(() => validateFixturePair(before, after)).not.toThrow();
  });

  it('rejects an alias importer that resolves to the package being replaced', async () => {
    const documents = await fixturePair();
    for (const document of documents) {
      const application = mapAt(document, ['1']);
      const importer = new Map<string, unknown>([
        [
          'dependencies',
          new Map([
            [
              'tui-alias',
              {
                specifier: `npm:${NAME}@${SOURCE_VERSION}`,
                version: `${NAME}@${SOURCE_VERSION}${peerSuffixFixture()}`,
              },
            ],
          ]),
        ],
      ]);
      mapAt(application, ['importers']).set('alias-consumer', importer);
    }
    const [before, after] = await serializeFixturePair(documents);
    expectErrorCode(() => validateFixturePair(before, after), 'TUI_BINDING_SHARED');
  });

  it('rejects another peer snapshot variant that would retain the removed package record', async () => {
    const documents = await fixturePair();
    const sourceKey = `${NAME}@${SOURCE_VERSION}${peerSuffixFixture()}`;
    const baseSnapshot = cloneFixtureValue(mapAt(documents[0], ['1', 'snapshots']).get(sourceKey));
    if (!(baseSnapshot instanceof Map)) {
      throw new Error('source TUI snapshot fixture is missing');
    }
    for (const document of documents) {
      const application = mapAt(document, ['1']);
      const snapshots = mapAt(application, ['snapshots']);
      snapshots.set(`${NAME}@${SOURCE_VERSION}(peer-alt@1.0.0)`, cloneFixtureValue(baseSnapshot));
    }
    const [before, after] = await serializeFixturePair(documents);
    expectErrorCode(() => validateFixturePair(before, after), 'TUI_BINDING_SHARED');
  });

  it('accepts the supported no-peer TUI binding', async () => {
    const documents = await fixturePair();
    const [beforeDocuments, afterDocuments] = documents;
    const beforeApp = mapAt(beforeDocuments, ['1']);
    const beforeDependency = mapAt(beforeApp, ['importers', '.', 'dependencies', NAME]);
    beforeDependency.set('version', SOURCE_VERSION);
    renameMapKey(
      mapAt(beforeApp, ['snapshots']),
      `${NAME}@${SOURCE_VERSION}${peerSuffixFixture()}`,
      `${NAME}@${SOURCE_VERSION}`,
    );
    const afterApp = mapAt(afterDocuments, ['1']);
    const afterDependency = mapAt(afterApp, ['importers', '.', 'dependencies', NAME]);
    afterDependency.set('version', TUI_URL);
    renameMapKey(
      mapAt(afterApp, ['snapshots']),
      `${NAME}@${TUI_URL}${peerSuffixFixture()}`,
      `${NAME}@${TUI_URL}`,
    );
    const [before, after] = await serializeFixturePair(documents);
    expect(() => validateFixturePair(before, after)).not.toThrow();
  });

  it('rejects floating-point YAML even when it is present in both otherwise-valid locks', async () => {
    const documents = await fixturePair();
    for (const document of documents) {
      mapAt(document, ['0']).set('floatProbe', 1.5);
    }
    const [before, after] = await serializeFixturePair(documents);
    expectErrorCode(() => validateFixturePair(before, after), 'YAML_FLOAT_UNSUPPORTED');
  });

  it('detects adjacent integers beyond JavaScript safe integer precision', async () => {
    const documents = await fixturePair();
    mapAt(documents[0], ['0']).set('integerProbe', 9_007_199_254_740_992n);
    mapAt(documents[1], ['0']).set('integerProbe', 9_007_199_254_740_993n);
    const [before, after] = await serializeFixturePair(documents);
    expectErrorCode(() => validateFixturePair(before, after), 'LOCK_DRIFT');
  });

  it('rejects malformed peer suffix and non-canonical expected URL by category', async () => {
    const documents = await fixturePair();
    mapAt(documents[0], ['1', 'importers', '.', 'dependencies', NAME]).set(
      'version',
      `${SOURCE_VERSION}()`,
    );
    const [malformed] = await serializeFixturePair(documents);
    const { before, after } = await c0Fixture();
    expectErrorCode(
      () =>
        validateTuiLockOverride({
          beforeLock: malformed,
          afterLock: after,
          sourcePackage: sourcePackage(),
          stagedPackage: stagedPackage(),
          expected: expectedOverride(),
        }),
      'REFERENCE_UNSUPPORTED',
    );
    expectErrorCode(
      () =>
        validateTuiLockOverride({
          beforeLock: before,
          afterLock: after,
          sourcePackage: sourcePackage(),
          stagedPackage: stagedPackage(),
          expected: { ...expectedOverride(), url: `${TUI_URL}\t` },
        }),
      'ARTIFACT_INPUT',
    );
  });

  it.each([
    ['direct', `(${NAME}@${SOURCE_VERSION})`],
    ['nested', `(@scope/container@1.0.0(${NAME}@${SOURCE_VERSION}))`],
  ])('rejects a %s self-peer in the selected TUI suffix', async (_kind, selfPeer) => {
    const documents = await fixturePair();
    const suffix = `${peerSuffixFixture()}${selfPeer}`;
    const beforeApp = mapAt(documents[0], ['1']);
    mapAt(beforeApp, ['importers', '.', 'dependencies', NAME]).set(
      'version',
      `${SOURCE_VERSION}${suffix}`,
    );
    renameMapKey(
      mapAt(beforeApp, ['snapshots']),
      `${NAME}@${SOURCE_VERSION}${peerSuffixFixture()}`,
      `${NAME}@${SOURCE_VERSION}${suffix}`,
    );
    const [sourceOnly] = await serializeFixturePair(documents);
    expectErrorCode(
      () =>
        validateTuiLockSource({
          sourceLock: sourceOnly,
          sourcePackage: sourcePackage(),
          expected: expectedOverride(),
        }),
      'TUI_BINDING_SHARED',
    );

    const afterApp = mapAt(documents[1], ['1']);
    mapAt(afterApp, ['importers', '.', 'dependencies', NAME]).set('version', `${TUI_URL}${suffix}`);
    renameMapKey(
      mapAt(afterApp, ['snapshots']),
      `${NAME}@${TUI_URL}${peerSuffixFixture()}`,
      `${NAME}@${TUI_URL}${suffix}`,
    );
    const [before, after] = await serializeFixturePair(documents);
    expectErrorCode(() => validateFixturePair(before, after), 'TUI_BINDING_SHARED');
  });

  it('rejects a target snapshot key that exceeds the bounded reference size', async () => {
    const { before } = await c0Fixture();
    const longUrl = `https://127.0.0.1:18446/tui/${TARBALL_SHA256}/${'a'.repeat(16 * 1024)}.tgz?sha256=${TARBALL_SHA256}`;
    expectErrorCode(
      () =>
        validateTuiLockSource({
          sourceLock: before,
          sourcePackage: sourcePackage(),
          expected: { ...expectedOverride(), url: longUrl },
        }),
      'LOCK_LIMIT',
    );
  });

  it.each([
    [
      'non-canonical toolchain integrity',
      (document: unknown) =>
        mapAt(document, ['0', 'packages', 'pnpm@12.5.1', 'resolution']).set(
          'integrity',
          'sha512-garbage',
        ),
    ],
    [
      'unreachable toolchain package record',
      (document: unknown) =>
        mapAt(document, ['0', 'packages']).set('orphan@1.0.0', 'invalid-record'),
    ],
  ])('rejects an invalid toolchain profile: %s', async (_description, mutate) => {
    const documents = await fixturePair();
    for (const document of documents) {
      mutate(document);
    }
    const [before, after] = await serializeFixturePair(documents);
    expectErrorCode(() => validateFixturePair(before, after), 'TOOLCHAIN_BINDING');
  });

  it('rejects a lock that changes an unrelated dependency despite matching URL and SRI text', async () => {
    const { before, after } = await c0Fixture();
    const corrupt = Buffer.from(
      replaceOnce(after.toString('utf8'), 'specifier: 11.1.28', 'specifier: 11.1.27'),
    );

    expect(() =>
      validateTuiLockOverride({
        beforeLock: before,
        afterLock: corrupt,
        sourcePackage: sourcePackage(),
        stagedPackage: stagedPackage(),
        expected: expectedOverride(),
      }),
    ).toThrow(/lockfile|drift|structural/u);
  });
});

async function c0Fixture(): Promise<{ before: Buffer; after: Buffer }> {
  const before = await readFile(
    new URL('./fixtures/acceptance-lockfile/pnpm-12.5.1-before.yaml', import.meta.url),
  );
  const after = await readFile(
    new URL('./fixtures/acceptance-lockfile/pnpm-12.5.1-after.yaml', import.meta.url),
  );
  return { before, after };
}

function sourcePackage() {
  return {
    name: '@revisium/revo',
    packageManager: 'pnpm@12.5.1',
    dependencies: { [NAME]: SOURCE_VERSION },
  };
}

function stagedPackage() {
  return {
    name: '@revisium/revo',
    packageManager: 'pnpm@12.5.1',
    dependencies: { [NAME]: TUI_URL },
  };
}

function expectedOverride(): {
  name: typeof NAME;
  version: string;
  url: string;
  integrity: string;
  tarballSha256: string;
} {
  return {
    name: NAME,
    version: TARBALL_VERSION,
    url: TUI_URL,
    integrity: INTEGRITY,
    tarballSha256: TARBALL_SHA256,
  };
}

function peerSuffixFixture(): string {
  return '(react-devtools-core@7.0.1)(typescript@7.0.2)(web-tree-sitter@0.25.10)(ws@8.21.3)';
}

function isStringMap(value: unknown): value is Map<string, unknown> {
  return value instanceof Map && [...value.keys()].every((key) => typeof key === 'string');
}

function mapAt(root: unknown, path: string[]): Map<string, unknown> {
  let value = root;
  for (const key of path) {
    if (Array.isArray(value) && /^(0|[1-9]\d*)$/u.test(key)) {
      const index = Number(key);
      if (index >= value.length) {
        throw new Error(`fixture array path is missing: ${path.join('/')}`);
      }
      value = value[index];
    } else {
      if (!(value instanceof Map) || !value.has(key)) {
        throw new Error(`fixture map path is missing: ${path.join('/')}`);
      }
      value = value.get(key);
    }
  }
  if (!isStringMap(value)) {
    throw new Error(`fixture path is not a map: ${path.join('/')}`);
  }
  return value;
}

function cloneFixtureValue(value: unknown): unknown {
  if (value instanceof Map) {
    return new Map([...value].map(([key, item]) => [key, cloneFixtureValue(item)]));
  }
  if (Array.isArray(value)) {
    return value.map(cloneFixtureValue);
  }
  return value;
}

function renameMapKey(map: Map<string, unknown>, oldKey: string, newKey: string): void {
  if (!map.has(oldKey) || map.has(newKey)) {
    throw new Error('fixture key rename precondition failed');
  }
  const value = map.get(oldKey);
  map.delete(oldKey);
  map.set(newKey, value);
}

async function fixturePair(): Promise<unknown[]> {
  const { before, after } = await c0Fixture();
  return [before, after].map((bytes) =>
    parseAllDocuments(bytes.toString('utf8')).map((document) => document.toJS({ mapAsMap: true })),
  );
}

async function serializeFixturePair(documents: unknown[]): Promise<[Buffer, Buffer]> {
  const serialized = documents.map((fileDocuments) => {
    if (!Array.isArray(fileDocuments)) {
      throw new Error('fixture documents are not an array');
    }
    return Buffer.from(fileDocuments.map((document) => stringify(document)).join('---\n'));
  });
  const [before, after] = serialized;
  if (serialized.length !== 2 || before === undefined || after === undefined) {
    throw new Error('expected exactly two fixture lockfiles');
  }
  return [before, after];
}

function validateFixturePair(beforeLock: Buffer, afterLock: Buffer) {
  return validateTuiLockOverride({
    beforeLock,
    afterLock,
    sourcePackage: sourcePackage(),
    stagedPackage: stagedPackage(),
    expected: expectedOverride(),
  });
}

function expectErrorCode(run: () => unknown, code: string): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code });
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function replaceOnce(value: string, search: string, replacement: string): string {
  const index = value.indexOf(search);
  if (index < 0) {
    throw new Error(`fixture did not contain expected marker: ${search}`);
  }
  return `${value.slice(0, index)}${replacement}${value.slice(index + search.length)}`;
}

function injectFirstDocument(bytes: Buffer, fragment: string): Buffer {
  return Buffer.from(
    replaceOnce(
      bytes.toString('utf8'),
      "lockfileVersion: '9.0'\n",
      `lockfileVersion: '9.0'\n${fragment}`,
    ),
  );
}

async function reformatAndReverseMaps(bytes: Buffer): Promise<Buffer> {
  const documents = parseAllDocuments(bytes.toString('utf8')).map((document) =>
    reverseMappings(document.toJS({ mapAsMap: true })),
  );
  return Buffer.from(documents.map((document) => stringify(document)).join('---\n'));
}

function reverseMappings(value: unknown): unknown {
  if (value instanceof Map) {
    return new Map(
      [...value.entries()].reverse().map(([key, item]) => [key, reverseMappings(item)]),
    );
  }
  if (Array.isArray(value)) {
    return value.map(reverseMappings);
  }
  return value;
}
