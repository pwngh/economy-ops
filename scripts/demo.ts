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
  requestPayout,
  spend,
  systemActor,
  topUp,
  userActor,
  workerCtxFrom,
} from '@pwngh/economy-lab';

import { createSupervisor, jsonlAuditSink, opsRuntime } from '#src/index.ts';

import type { Clock, Processor } from '@pwngh/economy-lab';

const say = (line: string): void => console.warn(line);

function manualClock(start: number): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

say('economy-ops demo: the stuck payout saga, closed loop.');
say('A host whose background worker is down: payouts park in RESERVED');
say('and nothing advances them. The supervisor notices and acts once.');
say('');

const clock = manualClock(Date.parse('2026-07-16T12:00:00Z'));
const runtime = opsRuntime({ meter: noopMeter(), logger: noopLogger(), clock });
const processor: Processor = {
  submitPayout: async () => ({ providerRef: 'prov_demo' }),
};
const caps = await capabilitiesFromEnv(
  { PAYOUT_MIN_EARNED_MINOR: '1000' },
  externalsFromEnv({}, { processor }),
  { clock, logger: runtime.logger, meter: runtime.meter },
);
const economy = economyFromCapabilities(caps);
const worker = createWorker(caps.store, workerCtxFrom(caps));

const buyer = 'usr_buyer';
const seller = 'usr_seller';
await economy.submit(
  topUp({
    idempotencyKey: 'idem_topup',
    actor: systemActor('billing'),
    userId: buyer,
    amount: credits(150),
    source: 'card',
  }),
);
await economy.submit(
  spend({
    idempotencyKey: 'idem_order',
    actor: userActor(buyer),
    orderId: 'ord_demo',
    buyerId: buyer,
    sku: 'gallery-print',
    price: credits(100),
    recipients: [{ sellerId: seller, shareBps: 10_000 }],
  }),
);
const request = await economy.submit(
  requestPayout({
    idempotencyKey: 'idem_payout',
    actor: userActor(seller),
    userId: seller,
    amount: credits(40),
  }),
);
if (request.status !== 'committed') {
  throw new Error(`requestPayout ${request.status}`);
}
const sagaId = request.transaction.meta.sagaId as string;
const before = await economy.read.saga(sagaId);
say(`payout requested: saga ${sagaId} is ${before?.state}, worker down.`);

const supervisor = createSupervisor({
  clock,
  signals: runtime.signals,
  sagas: caps.store.sagas,
  runSweep: (now) => worker.runOnce({ now, limit: 10 }),
  audit: jsonlAuditSink((line) => process.stdout.write(`${line}\n`)),
  config: { stuckSagaAgeMs: 60_000, actionCooldownMs: 30_000 },
});

say('tick at T+0: nothing is stuck yet, the supervisor emits nothing.');
await supervisor.tick();

clock.advance(120_000);
say(
  'two minutes pass. tick at T+2m (audit records on stdout, one JSON line each):',
);
await supervisor.tick();

const after = await economy.read.saga(sagaId);
say(`saga ${sagaId} is now ${after?.state}: the sweep advanced it.`);

const report = await economy.read.prove();
say(
  `prove: conserved=${report.conserved} chainIntact=${report.chainIntact} ` +
    `noOverdraft=${report.noOverdraft} — the supervisor wrote no ledger state.`,
);
