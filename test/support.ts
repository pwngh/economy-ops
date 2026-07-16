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

import type { Clock, Saga } from '@pwngh/economy-lab';
import type { AuditRecord, AuditSink } from '#src/audit.ts';
import type { SagaSource } from '#src/supervisor.ts';
import type { SignalFeed } from '#src/runtime.ts';

export function fixedClock(start = 0): Clock & { advance(ms: number): number } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
  };
}

export function recorder(): { records: AuditRecord[]; sink: AuditSink } {
  const records: AuditRecord[] = [];
  return { records, sink: (record) => records.push(record) };
}

export const noSignals: SignalFeed = { since: () => [] };

export function frozenSagaSource(sagas: ReadonlyArray<Saga>): SagaSource {
  return {
    list: async function* () {
      yield* sagas;
    },
    load: async (id) => sagas.find((saga) => saga.id === id) ?? null,
  };
}
