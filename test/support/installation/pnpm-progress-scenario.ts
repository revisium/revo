import {
  PnpmProgressParser,
  type PnpmProgressEvent,
} from '../../../src/installation/pnpm-progress.js';

// Captured with pnpm 12.4.1 and --reporter=ndjson in the isolated Node 26 fixture.
export const PNPM12_TRANSCRIPTS = Object.freeze({
  cold: [
    '{"time":1789497409359,"name":"pnpm:scope","level":"debug","selected":1}',
    '{"time":1789497409360,"name":"pnpm:stage","level":"debug","stage":"importing_started"}',
    '{"time":1789497409367,"name":"pnpm:progress","level":"debug","status":"resolved","packageId":"is-number@7.0.0"}',
    '{"time":1789497409473,"name":"pnpm:progress","level":"debug","status":"fetched","packageId":"is-number@7.0.0"}',
    '{"time":1789497409474,"name":"pnpm:root","level":"debug","added":{"name":"is-number","version":"7.0.0"}}',
    '{"time":1789497409474,"name":"pnpm:stage","level":"debug","stage":"importing_done"}',
  ].join('\n'),
  warm: [
    '{"time":1789497409498,"name":"pnpm:scope","level":"debug","selected":1}',
    '{"time":1789497409500,"name":"pnpm:stage","level":"debug","stage":"importing_started"}',
    '{"time":1789497409500,"name":"pnpm:stage","level":"debug","stage":"importing_done"}',
    '{"time":1789497409500,"name":"pnpm:execution-time","level":"debug"}',
  ].join('\n'),
  failure: 'Error: ERR_PNPM_BROKEN_LOCKFILE\n  × installing dependencies',
});

export function pnpmProgressScenario(
  transcript = PNPM12_TRANSCRIPTS.cold,
): readonly PnpmProgressEvent[] {
  const events: PnpmProgressEvent[] = [];
  const parser = new PnpmProgressParser({ onRaw: () => undefined });
  const source = transcript.endsWith('\n') ? transcript : `${transcript}\n`;
  for (let index = 0; index < source.length; index += 7) {
    events.push(...parser.feed(source.slice(index, index + 7)));
  }
  events.push(...parser.finish());
  return events;
}
