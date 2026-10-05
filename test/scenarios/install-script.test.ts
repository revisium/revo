import { afterEach, describe, expect, it } from 'vitest';

import { InstallMachine, type MachineOptions } from '../support/installation/install-machine.js';

const machines: InstallMachine[] = [];

const INTERRUPTED_BEFORE_SWITCH =
  'revo-alpha install: interrupted; the active version is unchanged, run the installer again.\n';

afterEach(async () => {
  await Promise.all(machines.splice(0).map((machine) => machine.dispose()));
});

async function cleanMachine(options: MachineOptions = {}) {
  const machine = await InstallMachine.create(options);
  machines.push(machine);
  return machine;
}

describe('install.sh', { timeout: 60_000 }, () => {
  it('installs private Node, pnpm and Revo on a clean machine without running Revo', async () => {
    const machine = await cleanMachine();
    const release = await machine.publish('alpha', '0.1.0-alpha.1');

    const result = await machine.install(release);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('Revo alpha 0.1.0-alpha.1 is installed.\n');
    expect(result.stdout).toContain('Run `revo-alpha` to start Revo.\n');
    expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.1');
    expect(await machine.revoInvocations()).toEqual([]);
    expect(await machine.hostToolInvocations()).toEqual([]);
    expect(await machine.pnpmInstalls()).toEqual([
      {
        args: expect.stringContaining('install --prod --frozen-lockfile'),
        node: machine.privateNode('alpha'),
      },
    ]);
    expect(await machine.runCommand('revo-alpha', ['--version'])).toBe('0.1.0-alpha.1');
    expect(await machine.channelEntries('alpha')).toEqual(['current', 'node', 'pnpm', 'versions']);
  });

  it('makes each channel launcher declare its own channel to Revo', async () => {
    const machine = await cleanMachine();
    await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));
    await machine.install(await machine.publish('stable', '1.0.0'));

    expect(await machine.runCommand('revo-alpha', ['--launcher-channel'])).toBe('alpha');
    expect(await machine.runCommand('revo', ['--launcher-channel'])).toBe('stable');
  });

  it('reports an already installed version and changes nothing', async () => {
    const machine = await cleanMachine();
    const release = await machine.publish('alpha', '0.1.0-alpha.1');
    await machine.install(release);
    const downloads = machine.downloads().length;

    const result = await machine.install(release);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('Revo alpha 0.1.0-alpha.1 is already installed.\n');
    expect(machine.downloads()).toHaveLength(downloads);
    expect(await machine.pnpmInstalls()).toHaveLength(1);
    expect(await machine.installedVersions('alpha')).toEqual(['0.1.0-alpha.1']);
    expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.1');
  });

  it('installs a new version side by side, switches to it and explains the restart', async () => {
    const machine = await cleanMachine();
    await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

    const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.2'));

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain(
      'Revo alpha 0.1.0-alpha.2 is installed (previous version 0.1.0-alpha.1).\n',
    );
    expect(result.stdout).toContain(
      'A running Revo alpha server keeps version 0.1.0-alpha.1 until it is restarted: run `revo-alpha server stop`, then `revo-alpha`.\n',
    );
    expect(await machine.installedVersions('alpha')).toEqual(['0.1.0-alpha.1', '0.1.0-alpha.2']);
    expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.2');
    expect(await machine.runCommand('revo-alpha', ['--version'])).toBe('0.1.0-alpha.2');
    expect(machine.downloads('/node/v')).toHaveLength(1);
    expect(machine.downloads('/pnpm/v')).toHaveLength(1);
  });

  it('keeps the previous version when interrupted during a download, and a rerun completes', async () => {
    const machine = await cleanMachine();
    await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));
    const next = await machine.publish('alpha', '0.1.0-alpha.2');
    const stalled = machine.stallDownload(next, 'package');

    const install = machine.startInstall(next);
    await stalled.requested;
    install.interrupt();
    const interrupted = await install.finished;

    expect(interrupted).toMatchObject({ exitCode: 130, stderr: INTERRUPTED_BEFORE_SWITCH });
    expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.1');
    expect(await machine.runCommand('revo-alpha', ['--version'])).toBe('0.1.0-alpha.1');
    expect(await machine.installerLeftovers('alpha')).toEqual([]);

    machine.restoreDownload(next, 'package');
    expect(await machine.install(next)).toMatchObject({ exitCode: 0 });
    expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.2');
  });

  it('keeps the previous version when interrupted during dependency installation, and a rerun completes', async () => {
    const machine = await cleanMachine();
    await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));
    const next = await machine.publish('alpha', '0.1.0-alpha.2');
    const pnpm = await machine.holdDependencyInstallation();

    const install = machine.startInstall(next);
    await pnpm.started;
    install.interrupt();
    const interrupted = await install.finished;

    expect(interrupted).toMatchObject({ exitCode: 130, stderr: INTERRUPTED_BEFORE_SWITCH });
    expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.1');
    expect(await machine.installedVersions('alpha')).toEqual(['0.1.0-alpha.1']);
    expect(await machine.installerLeftovers('alpha')).toEqual([]);

    expect(await machine.install(next)).toMatchObject({ exitCode: 0 });
    expect(await machine.installedVersions('alpha')).toEqual(['0.1.0-alpha.1', '0.1.0-alpha.2']);
    expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.2');
  });

  it('takes over the lock of a killed installer and cleans its partial work', async () => {
    const machine = await cleanMachine();
    const release = await machine.publish('alpha', '0.1.0-alpha.1');
    await machine.killInstallDuringDependencyInstallation(release);
    expect(await machine.installerLeftovers('alpha')).toEqual(['.lock', '.staging']);

    expect(await machine.install(release)).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.1');
    expect(await machine.installerLeftovers('alpha')).toEqual([]);
  });

  it('refuses an install lock without an owner and explains how to clear it', async () => {
    const machine = await cleanMachine();
    const release = await machine.publish('alpha', '0.1.0-alpha.1');
    await machine.leaveOwnerlessLock('alpha');

    const result = await machine.install(release);

    expect(result).toMatchObject({
      exitCode: 1,
      stderr: `revo-alpha install: another installation of Revo alpha is running; if it is not, remove ${machine.installLock('alpha')} and run the installer again.\n`,
    });
    expect(await machine.activeVersion('alpha')).toBeUndefined();
    expect(machine.downloads()).toEqual([]);
  });

  it('lets only one of two installers that start at the same moment install', async () => {
    const machine = await cleanMachine();
    const release = await machine.publish('alpha', '0.1.0-alpha.1');
    const pnpm = await machine.holdDependencyInstallation();

    const installs = await machine.startTwoInstallsAtOnce(release);
    const refused = await installs.firstToFinish;

    expect(refused).toMatchObject({
      exitCode: 1,
      stderr: expect.stringMatching(
        /^revo-alpha install: another installation of Revo alpha is running\b.*\n$/u,
      ),
    });
    await pnpm.started;
    pnpm.release();
    expect(await installs.lastToFinish).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.1');
    expect(await machine.installerLeftovers('alpha')).toEqual([]);
  });

  it('lets only one of two installers take over the lock of a killed installer', async () => {
    const machine = await cleanMachine();
    const release = await machine.publish('alpha', '0.1.0-alpha.1');
    await machine.killInstallDuringDependencyInstallation(release);
    await machine.raceTwoInstallersForTheStaleLock();

    const results = await Promise.all([machine.install(release), machine.install(release)]);

    expect(results.map(({ exitCode, stderr }) => ({ exitCode, stderr }))).toEqual(
      expect.arrayContaining([
        { exitCode: 0, stderr: '' },
        {
          exitCode: 1,
          stderr:
            'revo-alpha install: another installation of Revo alpha started at the same time.\n',
        },
      ]),
    );
    expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.1');
    expect(await machine.installerLeftovers('alpha')).toEqual([]);
  });

  it('refuses a second installation of the same channel while one is running', async () => {
    const machine = await cleanMachine();
    const release = await machine.publish('alpha', '0.1.0-alpha.1');
    const pnpm = await machine.holdDependencyInstallation();
    const first = machine.startInstall(release);
    await pnpm.started;

    const second = await machine.install(release);

    expect(second.exitCode).toBe(1);
    expect(second.stderr).toMatch(
      /^revo-alpha install: another installation of Revo alpha is running \(pid \d+\)\.\n$/u,
    );
    expect(await machine.activeVersion('alpha')).toBeUndefined();

    pnpm.release();
    expect(await first.finished).toMatchObject({ exitCode: 0 });
    expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.1');
  });

  it('rejects a checksum mismatch and changes nothing', async () => {
    const machine = await cleanMachine();
    const release = await machine.publish('alpha', '0.1.0-alpha.1');
    machine.corruptDownload(release, 'package');

    const result = await machine.install(release);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `revo-alpha install: checksum mismatch for ${release.assetUrl('package')}; nothing was changed.\n`,
    );
    expect(await machine.channelEntries('alpha')).toEqual([]);
    expect(await machine.commandLink('revo-alpha')).toBeUndefined();
  });

  it('reports a failed download and keeps the installed version', async () => {
    const machine = await cleanMachine();
    await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));
    const next = await machine.publish('alpha', '0.1.0-alpha.2');
    machine.removeDownload(next, 'lockfile');

    const result = await machine.install(next);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(
      /^revo-alpha install: download failed: \S+\/pnpm-lock\.yaml \(.+\); nothing was changed\.\n$/u,
    );
    expect(await machine.installedVersions('alpha')).toEqual(['0.1.0-alpha.1']);
    expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.1');
  });

  it.each([
    { system: 'FreeBSD', machine: 'amd64', found: 'FreeBSD amd64' },
    { system: 'Linux', machine: 'riscv64', found: 'Linux riscv64' },
    { system: 'Linux', machine: 'x86_64', glibc: 'glibc 2.31', found: 'glibc 2.31' },
    { system: 'Linux', machine: 'aarch64', found: 'no glibc' },
    { system: 'Darwin', machine: 'arm64', macos: '14.6', found: 'macOS 14.6' },
  ])('rejects an unsupported platform ($found) without changes', async (platform) => {
    const machine = await cleanMachine();
    const release = await machine.publish('alpha', '0.1.0-alpha.1');
    await machine.reportPlatform(platform);

    const result = await machine.install(release);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `revo-alpha install: unsupported platform (${platform.found}); Revo supports Linux x64 and arm64 with glibc 2.35 or newer, and macOS 15 or newer.\n`,
    );
    expect(await machine.homeEntries()).toEqual([]);
    expect(machine.downloads()).toEqual([]);
  });

  it.each([
    { system: 'Linux', machine: 'x86_64', glibc: 'glibc 2.35', archive: 'linux-x64' },
    { system: 'Linux', machine: 'aarch64', glibc: 'glibc 2.39', archive: 'linux-arm64' },
    { system: 'Linux', machine: 'arm64', glibc: 'glibc 3.0', archive: 'linux-arm64' },
    { system: 'Darwin', machine: 'arm64', macos: '15.0', archive: 'darwin-arm64' },
    { system: 'Darwin', machine: 'x86_64', macos: '26.1', archive: 'darwin-x64' },
  ])('installs the $archive toolchain on $system $machine', async (platform) => {
    const machine = await cleanMachine();
    const release = await machine.publish('alpha', '0.1.0-alpha.1');
    await machine.reportPlatform(platform);

    expect(await machine.install(release)).toMatchObject({ exitCode: 0, stderr: '' });
    expect(
      machine.downloads(`node-v${process.versions.node}-${platform.archive}.tar.gz`),
    ).toHaveLength(1);
    expect(machine.downloads(`pnpm-${platform.archive}.tar.gz`)).toHaveLength(1);
  });

  it('explains how to add ~/.local/bin to PATH only when it is missing', async () => {
    const hint =
      'Your PATH does not include ~/.local/bin; add this line to your shell profile: export PATH="$HOME/.local/bin:$PATH"\n';
    const withoutBin = await cleanMachine();
    const withBin = await cleanMachine({ binDirOnPath: true });

    const missing = await withoutBin.install(await withoutBin.publish('alpha', '0.1.0-alpha.1'));
    const present = await withBin.install(await withBin.publish('alpha', '0.1.0-alpha.1'));

    expect(missing.stdout).toContain(hint);
    expect(present.stdout).not.toContain('PATH');
  });

  it('keeps stable and alpha installations independent', async () => {
    const machine = await cleanMachine();
    await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));
    await machine.install(await machine.publish('stable', '1.0.0'));
    const alphaEntries = await machine.channelTree('alpha');

    const upgrade = await machine.install(await machine.publish('stable', '1.0.1'));

    expect(upgrade.stdout).toContain('Revo 1.0.1 is installed (previous version 1.0.0).\n');
    expect(upgrade.stdout).toContain('run `revo server stop`, then `revo`.');
    expect(await machine.channelTree('alpha')).toEqual(alphaEntries);
    expect(await machine.runCommand('revo-alpha', ['--version'])).toBe('0.1.0-alpha.1');
    expect(await machine.runCommand('revo', ['--version'])).toBe('1.0.1');
    expect(await machine.commandLink('revo')).toBe(machine.commandTarget('stable', 'revo'));
    expect(await machine.commandLink('revo-alpha')).toBe(
      machine.commandTarget('alpha', 'revo-alpha'),
    );
  });

  it('keeps the program out of every channel data, configuration, state and cache directory', async () => {
    const machine = await cleanMachine();

    await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));
    await machine.install(await machine.publish('stable', '1.0.0'));

    expect(await machine.runCommand('revo-alpha', ['--version'])).toBe('0.1.0-alpha.1');
    expect(await machine.runCommand('revo', ['--version'])).toBe('1.0.0');
    expect(await machine.existingUserDirectories()).toEqual([]);
  });

  it.each(['configuration file', 'environment'] as const)(
    'runs dependency build scripts even when the user pnpm %s skips them',
    async (source) => {
      const machine = await cleanMachine();
      await machine.skipBuildScriptsInUserPnpmSettings(source);

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      expect(await machine.runCommand('revo-alpha', ['--version'])).toBe('0.1.0-alpha.1');
    },
  );

  it.each(['configuration file', 'environment'] as const)(
    'installs even when the user pnpm %s rejects dependencies made for another Node.js',
    async (source) => {
      const machine = await cleanMachine();
      await machine.enforceDependencyEnginesInUserPnpmSettings(source);

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      expect(await machine.runCommand('revo-alpha', ['--version'])).toBe('0.1.0-alpha.1');
    },
  );

  it('installs into an install root whose path has a space and a quote', async () => {
    const machine = await cleanMachine({ installRoot: "Revo's programs" });

    const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.1');
    expect(await machine.runCommand('revo-alpha', ['--version'])).toBe('0.1.0-alpha.1');
  });

  it('installs from a project directory that pins another package manager', async () => {
    const machine = await cleanMachine();
    await machine.workInProjectPinning('npm@10.9.0');

    const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.1');
  });

  it('refuses to replace a command it did not create', async () => {
    const machine = await cleanMachine();
    const release = await machine.publish('alpha', '0.1.0-alpha.1');
    await machine.placeForeignCommand('revo-alpha');

    const result = await machine.install(release);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `revo-alpha install: ${machine.commandPath('revo-alpha')} exists and was not created by this installer; remove it and run the installer again.\n`,
    );
    expect(await machine.foreignCommandIntact('revo-alpha')).toBe(true);
    expect(await machine.channelEntries('alpha')).toEqual([]);
  });

  describe('system libraries', () => {
    const INSTALL = 'apt-get install -y libatomic1';
    const NEEDS = 'revo-alpha install: Node.js needs libatomic.so.1, which is missing';

    async function machineLackingLibrary() {
      const machine = await cleanMachine();
      await machine.lackSystemLibrary();
      return machine;
    }

    async function expectNothingChanged(machine: InstallMachine) {
      expect(await machine.homeEntries()).toEqual([]);
      expect(machine.downloads()).toEqual([]);
      expect(await machine.systemCommands()).toEqual([]);
    }

    it('asks before installing the missing library with sudo, then continues', async () => {
      const machine = await machineLackingLibrary();
      await machine.havePackageManager('apt-get');
      await machine.haveSudo();
      await machine.answerPrompt('y');

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      expect(result.stdout).toContain(`The installer will run: sudo ${INSTALL}\n`);
      expect(await machine.promptShown()).toBe('Run it now? [Y/n] ');
      expect(await machine.systemCommands()).toEqual([`sudo ${INSTALL}`]);
      expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.1');
    });

    it('installs on an empty answer, which accepts the default', async () => {
      const machine = await machineLackingLibrary();
      await machine.havePackageManager('apt-get');
      await machine.haveSudo();
      await machine.answerPrompt('');

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result.exitCode).toBe(0);
      expect(await machine.systemCommands()).toEqual([`sudo ${INSTALL}`]);
    });

    it('prints the exact command and changes nothing when the answer is no', async () => {
      const machine = await machineLackingLibrary();
      await machine.havePackageManager('apt-get');
      await machine.haveSudo();
      await machine.answerPrompt('n');

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        `${NEEDS}; install it with \`sudo ${INSTALL}\` and run the installer again.\n`,
      );
      await expectNothingChanged(machine);
    });

    it('prints the command and the opt-in without a terminal, and changes nothing', async () => {
      const machine = await machineLackingLibrary();
      await machine.havePackageManager('apt-get');
      await machine.haveSudo();

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        `${NEEDS}; install it with \`sudo ${INSTALL}\` and run the installer again, or run the installer with REVO_INSTALL_SYSTEM_DEPS=1 to let it do that.\n`,
      );
      await expectNothingChanged(machine);
    });

    it('refuses when the terminal ends without an answer, and changes nothing', async () => {
      const machine = await machineLackingLibrary();
      await machine.havePackageManager('apt-get');
      await machine.haveSudo();
      await machine.closeTerminalWithoutAnswer();

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        `${NEEDS}; install it with \`sudo ${INSTALL}\` and run the installer again.\n`,
      );
      await expectNothingChanged(machine);
    });

    it('does not retry after a failure that is not about the package lists', async () => {
      const machine = await machineLackingLibrary();
      await machine.havePackageManager('apt-get', { failWith: 'sudo: a terminal is required' });
      await machine.haveSudo();
      machine.allowSystemDependencyInstall();

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('sudo: a terminal is required');
      expect(result.stderr).toContain(`\`sudo ${INSTALL}\` failed`);
      expect(await machine.systemCommands()).toEqual([`sudo ${INSTALL}`]);
    });

    it('finds the library in the library directories when ldconfig fails', async () => {
      const machine = await machineLackingLibrary();
      await machine.searchLibrariesOnlyIn({ libatomic: true });
      await machine.havePackageManager('apt-get');
      await machine.haveSudo();

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      expect(await machine.systemCommands()).toEqual([]);
    });

    it('reports the library missing when ldconfig fails and the directories lack it', async () => {
      const machine = await machineLackingLibrary();
      await machine.searchLibrariesOnlyIn({ libatomic: false });
      await machine.havePackageManager('apt-get');
      await machine.haveSudo();

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(NEEDS);
    });

    it('installs without a terminal when the user opted in', async () => {
      const machine = await machineLackingLibrary();
      await machine.havePackageManager('apt-get');
      await machine.haveSudo();
      machine.allowSystemDependencyInstall();

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      expect(await machine.systemCommands()).toEqual([`sudo ${INSTALL}`]);
      expect(await machine.activeVersion('alpha')).toBe('0.1.0-alpha.1');
    });

    it('installs without asking when the user opted in at a terminal', async () => {
      const machine = await machineLackingLibrary();
      await machine.havePackageManager('apt-get');
      await machine.haveSudo();
      machine.allowSystemDependencyInstall();
      await machine.answerPrompt('n');

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result.exitCode).toBe(0);
      expect(await machine.promptShown()).toBe('');
      expect(await machine.systemCommands()).toEqual([`sudo ${INSTALL}`]);
    });

    it('refreshes the package lists when the first install fails for lack of them', async () => {
      const machine = await machineLackingLibrary();
      await machine.havePackageManager('apt-get', { staleLists: true });
      await machine.haveSudo();
      machine.allowSystemDependencyInstall();

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result.exitCode).toBe(0);
      expect(await machine.systemCommands()).toEqual([
        `sudo ${INSTALL}`,
        'sudo apt-get update',
        `sudo ${INSTALL}`,
      ]);
    });

    it('fails clearly when the library is still missing after the install', async () => {
      const machine = await machineLackingLibrary();
      await machine.havePackageManager('apt-get');
      await machine.haveSudo();
      machine.allowSystemDependencyInstall();
      await machine.keepLibraryMissingAfterInstall();

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        `${NEEDS} even after \`sudo ${INSTALL}\`; install it and run the installer again.\n`,
      );
      expect(machine.downloads()).toEqual([]);
    });

    it('installs directly as root, without sudo', async () => {
      const machine = await machineLackingLibrary();
      await machine.havePackageManager('apt-get');
      await machine.runAsRoot();

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      expect(await machine.systemCommands()).toEqual([INSTALL]);
    });

    it('tells the user to install as root when there is no sudo and the user is not root', async () => {
      const machine = await machineLackingLibrary();
      await machine.havePackageManager('apt-get');

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        `${NEEDS}; install it as root with \`${INSTALL}\` and run the installer again.\n`,
      );
      await expectNothingChanged(machine);
    });

    it('names the library when no known package manager exists', async () => {
      const machine = await machineLackingLibrary();
      await machine.haveSudo();

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        `${NEEDS}; install the package that provides it and run the installer again.\n`,
      );
      await expectNothingChanged(machine);
    });

    it.each([
      { manager: 'apt-get', command: 'apt-get install -y libatomic1' },
      { manager: 'dnf', command: 'dnf install -y libatomic' },
      { manager: 'yum', command: 'yum install -y libatomic' },
      { manager: 'zypper', command: 'zypper --non-interactive install libatomic1' },
      { manager: 'pacman', command: 'pacman -S --noconfirm --needed gcc-libs' },
    ])('installs the package that $manager names for the library', async ({ command, manager }) => {
      const machine = await machineLackingLibrary();
      await machine.havePackageManager(manager);
      await machine.runAsRoot();

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result.exitCode).toBe(0);
      expect(await machine.systemCommands()).toEqual([command]);
    });

    it('neither asks nor uses sudo when the library is present', async () => {
      const machine = await cleanMachine();
      await machine.reportPlatform({ system: 'Linux', machine: 'x86_64', glibc: 'glibc 2.35' });
      await machine.havePackageManager('apt-get');
      await machine.haveSudo();
      await machine.answerPrompt('n');

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      expect(await machine.promptShown()).toBe('');
      expect(await machine.systemCommands()).toEqual([]);
    });

    it('does not look for libraries on macOS', async () => {
      const machine = await machineLackingLibrary();
      await machine.reportPlatform({ system: 'Darwin', machine: 'arm64', macos: '15.0' });

      const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    });

    it.each(['node', 'pnpm'] as const)(
      'shows the loader error when the unpacked %s does not run',
      async (tool) => {
        const machine = await cleanMachine({ brokenToolchain: tool });

        const result = await machine.install(await machine.publish('alpha', '0.1.0-alpha.1'));

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(
          new RegExp(
            `^revo-alpha install: ${tool === 'node' ? `Node\\.js ${process.versions.node}` : 'pnpm 12\\.8\\.2'} does not run on this machine: \\./${tool}: error while loading shared libraries: libatomic\\.so\\.1: cannot open shared object file: No such file or directory\\n$`,
            'u',
          ),
        );
        expect(await machine.activeVersion('alpha')).toBeUndefined();
      },
    );
  });
});
