/**
 * @pwngh/economy-ops
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import {
  capabilitiesFromEnv,
  createWorker,
  credits,
  economyFromCapabilities,
  externalsFromEnv,
  noopLogger,
  noopMeter,
  systemActor,
  topUp,
  workerCtxFrom,
} from '@pwngh/economy-lab';

import { createSupervisor, jsonlAuditSink, opsRuntime } from '#src/index.ts';

import type { Clock } from '@pwngh/economy-lab';

const say = (line: string): void => console.warn(line);

function manualClock(start: number): Clock {
  return { now: () => start };
}

say('economy-ops demo: the integrity mismatch, escalation only.');
say('A stored posting is tampered behind the ledger. The checkpoint reverify');
say(
  'catches it; the supervisor gathers proof and escalates. It fixes nothing.',
);
say('');

const clock = manualClock(Date.parse('2026-07-16T12:00:00Z'));
const runtime = opsRuntime({ meter: noopMeter(), logger: noopLogger(), clock });
const caps = await capabilitiesFromEnv(
  {},
  externalsFromEnv(
    {},
    { processor: { submitPayout: async () => ({ providerRef: 'p' }) } },
  ),
  { clock, logger: runtime.logger, meter: runtime.meter },
);
const economy = economyFromCapabilities(caps);
const worker = createWorker(caps.store, workerCtxFrom(caps));

const topped = await economy.submit(
  topUp({
    idempotencyKey: 'idem_topup',
    actor: systemActor('billing'),
    userId: 'usr_a',
    amount: credits(100),
    source: 'card',
  }),
);
if (topped.status !== 'committed') {
  throw new Error(`topUp ${topped.status}`);
}
await worker.runOnce({ now: clock.now(), limit: 10 });
say(`a top-up committed (${topped.transaction.id}) and the checkpoint sealed.`);

const supervisor = createSupervisor({
  clock,
  signals: runtime.signals,
  sagas: { list: async function* () {}, load: async () => null },
  runSweep: async () => {
    throw new Error('integrity findings must never trigger the sweep');
  },
  audit: jsonlAuditSink((line) => process.stdout.write(`${line}\n`)),
  prove: () => economy.read.prove(),
  escalate: (record) => {
    const proof = record.detail.proof as {
      conserved: boolean;
      drift: unknown[];
    };
    say(
      `ESCALATED to a human: conserved=${proof.conserved}, ` +
        `${proof.drift.length} drifted account(s) in the attached report.`,
    );
  },
});

await supervisor.tick();
say('tick with an intact ledger: the supervisor emits nothing.');

const tamper = (
  caps.store.ledger as unknown as {
    __tamper?: (
      txnId: string,
      mutate: (legs: Array<{ amount: { minor: bigint } }>) => void,
    ) => void;
  }
).__tamper;
tamper?.(topped.transaction.id, (legs) => {
  legs[0].amount.minor += 1n;
});
say('a leg of the stored posting is tampered: +1 minor unit out of thin air.');

await worker.runOnce({ now: clock.now(), limit: 10 });
say('the next sweep reverifies the sealed checkpoint and reports a mismatch.');
say('tick (audit records on stdout):');
await supervisor.tick();

const report = await economy.read.prove();
say(
  `prove now says conserved=${report.conserved} — the evidence is attached, ` +
    'the response is human. No automated action touched the ledger.',
);
