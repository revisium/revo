import { PostgresLifecycleScenario } from './postgres-lifecycle-scenario.js';

export class PostgresLifecycleTestScope {
  private scenario: PostgresLifecycleScenario | undefined;
  private cleanupAttempt: Promise<void> | undefined;
  private cleanupFailure: unknown;
  private cleanupFailed = false;

  constructor(private readonly createScenario = () => new PostgresLifecycleScenario()) {}

  begin() {
    if (this.cleanupAttempt) {
      throw new Error('PostgreSQL lifecycle scenario cleanup is still pending');
    }
    if (this.cleanupFailed) {
      throw new Error('Previous PostgreSQL lifecycle scenario cleanup failed', {
        cause: this.cleanupFailure,
      });
    }
    if (this.scenario) {
      throw new Error('PostgreSQL lifecycle scenario has not been cleaned up');
    }
    this.scenario = this.createScenario();
    return this.scenario;
  }

  cleanup() {
    if (this.cleanupAttempt) {
      return this.cleanupAttempt;
    }
    const scenario = this.scenario;
    if (!scenario) {
      return Promise.resolve();
    }

    const attempt = Promise.resolve()
      .then(() => scenario.cleanup())
      .then(
        () => {
          if (this.scenario === scenario) {
            this.scenario = undefined;
          }
          this.cleanupFailure = undefined;
          this.cleanupFailed = false;
        },
        (error: unknown) => {
          this.cleanupFailure = error;
          this.cleanupFailed = true;
          throw error;
        },
      )
      .finally(() => {
        if (this.cleanupAttempt === attempt) {
          this.cleanupAttempt = undefined;
        }
      });
    this.cleanupAttempt = attempt;
    return attempt;
  }
}
