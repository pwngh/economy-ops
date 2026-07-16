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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { credits, noopLogger, noopMeter } from '@pwngh/economy-lab';

import { createSupervisor, opsRuntime } from '#src/index.ts';
import {
  fixedClock,
  frozenSagaSource,
  noSignals,
  recorder,
} from '#test/support.ts';

import type { Saga } from '@pwngh/economy-lab';
import type { AuditRecord } from '#src/index.ts';

function stuckSaga(id: string): Saga {
  return {
    id,
    userId: 'usr_seller',
    reserve: credits(40),
    rateId: 'rate_test',
    state: 'RESERVED',
    providerRef: null,
    reason: null,
    attempts: 0,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: null,
  };
}

test('guardrails: cooldown suppresses, the attempt cap escalates once, then acting stops', async () => {
  const clock = fixedClock(100_000);
  const { records, sink } = recorder();
  const escalations: AuditRecord[] = [];
  let sweeps = 0;
  const supervisor = createSupervisor({
    clock,
    signals: noSignals,
    sagas: frozenSagaSource([stuckSaga('saga_stuck')]),
    runSweep: async () => {
      sweeps += 1;
    },
    audit: sink,
    escalate: (record) => escalations.push(record),
    config: {
      stuckSagaAgeMs: 1_000,
      actionCooldownMs: 5_000,
      maxActionAttempts: 3,
    },
  });

  const first = await supervisor.tick();
  assert.deepEqual(
    first.map((record) => record.phase),
    ['detected', 'decided', 'acted', 'verified'],
  );
  assert.equal(sweeps, 1);
  const verified = first.find((record) => record.phase === 'verified');
  assert.equal(verified?.detail.outcome, 'unchanged');

  const cooled = await supervisor.tick();
  assert.deepEqual(
    cooled.map((record) => record.phase),
    ['detected', 'decided'],
  );
  assert.equal(cooled[1].detail.reason, 'cooldown');
  assert.equal(sweeps, 1);

  clock.advance(6_000);
  await supervisor.tick();
  clock.advance(6_000);
  await supervisor.tick();
  assert.equal(sweeps, 3);
  assert.equal(escalations.length, 0);

  clock.advance(6_000);
  const capped = await supervisor.tick();
  assert.deepEqual(
    capped.map((record) => record.phase),
    ['detected', 'escalated'],
  );
  assert.equal(sweeps, 3);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].detail.attempts, 3);

  clock.advance(6_000);
  const after = await supervisor.tick();
  assert.deepEqual(
    after.map((record) => record.phase),
    ['detected', 'decided'],
  );
  assert.equal(after[1].detail.reason, 'escalated');
  assert.equal(sweeps, 3);
  assert.equal(escalations.length, 1);
  assert.equal(
    records.filter((record) => record.phase === 'escalated').length,
    1,
  );
});

test('a tick arriving while one is in flight is skipped, not queued', async () => {
  const clock = fixedClock(100_000);
  const { records, sink } = recorder();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sweeps = 0;
  const stuck = stuckSaga('saga_slow');
  const supervisor = createSupervisor({
    clock,
    signals: noSignals,
    sagas: {
      list: async function* () {
        await gate;
        yield stuck;
      },
      load: async () => stuck,
    },
    runSweep: async () => {
      sweeps += 1;
    },
    audit: sink,
    config: { stuckSagaAgeMs: 1_000, actionCooldownMs: 0 },
  });

  const first = supervisor.tick();
  const second = await supervisor.tick();
  assert.deepEqual(second, []);

  release();
  const firstRecords = await first;
  assert.equal(sweeps, 1);
  assert.equal(
    firstRecords.filter((record) => record.phase === 'decided').length,
    1,
  );
  assert.equal(records.length, firstRecords.length);
});

test('a healthy tick emits nothing', async () => {
  const { records, sink } = recorder();
  const supervisor = createSupervisor({
    clock: fixedClock(1_000),
    signals: noSignals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {},
    audit: sink,
  });

  assert.deepEqual(await supervisor.tick(), []);
  assert.deepEqual(records, []);
});

test('an integrity mismatch proves once, escalates once, and never re-fires', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { records, sink } = recorder();
  const escalations: AuditRecord[] = [];
  let proves = 0;
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {
      throw new Error('must never be called for integrity findings');
    },
    audit: sink,
    prove: async () => {
      proves += 1;
      return { chainIntact: false };
    },
    escalate: (record) => escalations.push(record),
  });

  clock.advance(10);
  runtime.meter.count('worker.checkpoint.verify', 1, { outcome: 'mismatch' });
  runtime.logger.log('error', 'worker.checkpoint.mismatch', {});

  const detectedTick = await supervisor.tick();
  assert.deepEqual(
    detectedTick.map((record) => record.phase),
    ['detected', 'escalated'],
  );
  assert.equal(detectedTick[0].detail.signals, 2);
  assert.equal(proves, 1);
  assert.equal(escalations.length, 1);
  assert.deepEqual(escalations[0].detail.proof, { chainIntact: false });

  const quietTick = await supervisor.tick();
  assert.deepEqual(quietTick, []);
  assert.equal(proves, 1);
  assert.equal(records.length, 2);
});

test('a deadlock storm advises once per window and takes no action', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { records, sink } = recorder();
  let sweeps = 0;
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {
      sweeps += 1;
    },
    audit: sink,
    config: { deadlockWindowMs: 1_000, deadlockThreshold: 20 },
  });

  for (let i = 0; i < 25; i += 1) {
    runtime.meter.count('engine.retry', 1, { conflict: 'deadlock' });
  }

  const stormTick = await supervisor.tick();
  assert.deepEqual(
    stormTick.map((record) => record.phase),
    ['detected', 'decided'],
  );
  assert.equal(stormTick[0].detail.retries, 25);
  assert.equal(stormTick[1].detail.decision, 'advise');
  assert.equal(sweeps, 0);

  assert.deepEqual(await supervisor.tick(), []);

  clock.advance(2_000);
  assert.deepEqual(await supervisor.tick(), []);
  assert.equal(records.length, 2);
});
