import { homedir } from 'node:os';
import process from 'node:process';

import { Inject, Injectable } from '@nestjs/common';

import { ConfigurationResolver } from '../../configuration/configuration-resolver.js';
import type {
  ConfigurationFlags,
  ConfigurationInput,
  RevoConfiguration,
} from '../../configuration/configuration.types.js';
import { ServerStatusService, type ServerStatus } from '../../server/server-status.service.js';
import { PackageMetadataService } from '../package-metadata.service.js';
import { DoctorComponentProbe, type DoctorComponents } from './doctor-component-probe.js';
import { DoctorPathProbe, type DoctorPaths } from './doctor-path-probe.js';

export interface DoctorReport {
  readonly version: string;
  readonly node: string;
  readonly platform: string;
  readonly channel: RevoConfiguration['channel'];
  readonly configuration: 'valid';
  readonly paths: DoctorPaths;
  readonly components: DoctorComponents;
  readonly server: ServerStatus['kind'];
}

@Injectable()
export class DoctorService {
  constructor(
    @Inject(ConfigurationResolver)
    private readonly configuration: Pick<
      ConfigurationResolver,
      'resolve'
    > = new ConfigurationResolver(),
    @Inject(DoctorPathProbe)
    private readonly pathProbe: Pick<DoctorPathProbe, 'inspect'> = new DoctorPathProbe(),
    @Inject(DoctorComponentProbe)
    private readonly componentProbe: Pick<
      DoctorComponentProbe,
      'inspect'
    > = new DoctorComponentProbe(),
    @Inject(ServerStatusService)
    private readonly serverStatus: Pick<ServerStatusService, 'read'> = new ServerStatusService(),
    @Inject(PackageMetadataService)
    private readonly metadata: Pick<
      PackageMetadataService,
      'version'
    > = new PackageMetadataService(),
  ) {}

  async inspect(input: Readonly<ConfigurationInput>): Promise<DoctorReport> {
    const configuration = await this.configuration.resolve(input);
    const [paths, components, server] = await Promise.all([
      this.pathProbe.inspect({
        data: configuration.layout.dataDir,
        state: configuration.layout.stateDir,
        logs: configuration.logDir,
      }),
      this.componentProbe.inspect(configuration),
      this.readServer(configuration.layout.dataDir),
    ]);

    return Object.freeze({
      version: input.packageVersion,
      node: process.versions.node,
      platform: input.platform,
      channel: configuration.channel,
      configuration: 'valid',
      paths,
      components,
      server,
    });
  }

  isHealthy(report: Readonly<DoctorReport>): boolean {
    return (
      (report.server === 'running' || report.server === 'stopped') &&
      report.components.core === 'available' &&
      report.components.admin === 'available' &&
      report.components.postgres !== 'unavailable' &&
      report.paths.data !== 'unavailable' &&
      report.paths.state !== 'unavailable' &&
      report.paths.logs !== 'unavailable'
    );
  }

  createInput(flags: Readonly<ConfigurationFlags> = {}): ConfigurationInput {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error('Doctor is unsupported on this platform.');
    }
    return {
      env: { ...process.env },
      flags,
      homeDir: homedir(),
      packageVersion: this.metadata.version,
      platform: process.platform,
    };
  }

  private async readServer(dataDir: string): Promise<ServerStatus['kind']> {
    try {
      return (await this.serverStatus.read(dataDir)).kind;
    } catch {
      return 'unknown';
    }
  }
}
