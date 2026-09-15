import { Command } from 'nest-commander';

import { DoctorService, type DoctorReport } from '../diagnostics/doctor.service.js';
import { OutputService } from '../output.service.js';
import { StrictCommandRunner } from './strict-command-runner.js';

@Command({ name: 'doctor', description: 'Inspect the Revo installation' })
export class DoctorCommand extends StrictCommandRunner {
  constructor(
    private readonly doctor: DoctorService,
    private readonly output: OutputService,
  ) {
    super();
  }

  async run(): Promise<void> {
    const report = await this.doctor.inspect(this.doctor.createInput());
    this.output.write(render(report));
    if (!this.doctor.isHealthy(report)) {
      throw new Error('Revo doctor found an unhealthy installation.');
    }
  }
}

function render(report: Readonly<DoctorReport>): string {
  return [
    `version: ${report.version}`,
    `node: ${report.node}`,
    `platform: ${report.platform}`,
    `channel: ${report.channel}`,
    `configuration: ${report.configuration}`,
    `data: ${report.paths.data}`,
    `state: ${report.paths.state}`,
    `logs: ${report.paths.logs}`,
    `core: ${report.components.core}`,
    `admin: ${report.components.admin}`,
    `postgres: ${report.components.postgres}`,
    `server: ${report.server}`,
  ].join('\n');
}
