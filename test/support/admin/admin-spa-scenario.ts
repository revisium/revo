import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { RevoCoreRuntime } from '@revisium/revo-core/runtime';

import { mountAdminSpa } from '../../../src/admin/admin-spa.js';

@Module({})
// oxlint-disable-next-line typescript/no-extraneous-class -- Nest modules are decorator metadata
class AdminHttpModule {}

export class AdminSpaScenario {
  private application: RevoCoreRuntime['app'] | undefined;

  async setup(directory: string): Promise<void> {
    await mkdir(join(directory, 'assets'), { recursive: true });
    await writeFile(join(directory, 'index.html'), '<!doctype html><title>Admin</title>');
    this.application = await NestFactory.create<RevoCoreRuntime['app']>(AdminHttpModule, {
      logger: false,
    });
    mountAdminSpa(this.application, directory);
  }

  async listen(): Promise<string> {
    const application = this.requiredApplication();
    await application.listen(0, '127.0.0.1');
    return application.getUrl();
  }

  async close(): Promise<void> {
    if (this.application === undefined) {
      return;
    }
    const application = this.application;
    await application.close();
    this.application = undefined;
  }

  private requiredApplication(): RevoCoreRuntime['app'] {
    if (this.application === undefined) {
      throw new Error('Admin scenario is not set up');
    }
    return this.application;
  }
}
