import { afterEach, describe, expect, it } from 'vitest';

import { PrivateFilesScenario } from '../support/private-files/private-files-scenario.js';

describe('private file reads', () => {
  let scenario = new PrivateFilesScenario();
  afterEach(async () => {
    await scenario.cleanup();
    scenario = new PrivateFilesScenario();
  });

  it('reads content up to the limit and rejects anything larger', async () => {
    expect(await scenario.readsFileOf(8)).toBe('xxxxxxxx');
    expect(await scenario.readsFileOf(9)).toBeUndefined();
  });

  it('reads a private file of a private data directory with its canonical directory', async () => {
    const dataDir = await scenario.withFile('hello');
    expect(await scenario.read(dataDir)).toMatchObject({ kind: 'read', content: 'hello' });
  });

  it('reports a missing data directory and a missing file as missing', async () => {
    const dataDir = await scenario.dataDirectory();
    expect(await scenario.read(`${dataDir}/absent`)).toEqual({ kind: 'missing' });
    expect(await scenario.read(dataDir)).toEqual({ kind: 'missing' });
  });

  it('reports a data directory that others can access as unavailable', async () => {
    const dataDir = await scenario.dataDirectory(0o755);
    expect(await scenario.read(dataDir)).toEqual({ kind: 'unavailable' });
  });

  it('reports a symlinked file as unavailable', async () => {
    const dataDir = await scenario.symlinkedFile();
    expect(await scenario.read(dataDir)).toEqual({ kind: 'unavailable' });
  });

  it.each([
    ['empty', () => scenario.withFile('')],
    ['oversized', () => scenario.withFile('x'.repeat(9))],
    ['readable by others', () => scenario.withFile('ok', 0o644)],
    ['a directory', () => scenario.directoryInPlaceOfFile()],
  ])('reports a %s file as invalid', async (_name, prepare) => {
    expect(await scenario.read(await prepare())).toEqual({ kind: 'invalid' });
  });

  it('accepts only a private regular file with a single link', async () => {
    expect(await scenario.identityOf({ hardLink: false, mode: 0o600 })).toBe(true);
    expect(await scenario.identityOf({ hardLink: true, mode: 0o600 })).toBe(false);
    expect(await scenario.identityOf({ hardLink: false, mode: 0o640 })).toBe(false);
  });
});
