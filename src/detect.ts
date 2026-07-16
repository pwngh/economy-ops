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

import type { Saga } from '@pwngh/economy-lab';
import type { Signal, SignalFeed } from './runtime.ts';

export type DeadlockStormFinding = {
  signature: 'deadlock-storm';
  retries: number;
  windowMs: number;
};

export type StuckSagaFinding = {
  signature: 'stuck-saga';
  saga: Saga;
  ageMs: number;
};

export type IntegrityMismatchFinding = {
  signature: 'integrity-mismatch';
  at: number;
  channel: 'meter' | 'log';
};

export type Finding =
  DeadlockStormFinding | StuckSagaFinding | IntegrityMismatchFinding;

const TERMINAL_SAGA_STATES: ReadonlySet<Saga['state']> = new Set([
  'SETTLED',
  'FAILED',
]);

export function detectDeadlockStorm(
  signals: SignalFeed,
  now: number,
  options: { metric: string; windowMs: number; threshold: number },
): DeadlockStormFinding | null {
  const retries = signals
    .since(now - options.windowMs)
    .filter(
      (signal) => signal.source === 'meter' && signal.name === options.metric,
    )
    .reduce((sum, signal) => sum + signal.value, 0);
  if (retries < options.threshold) {
    return null;
  }
  return { signature: 'deadlock-storm', retries, windowMs: options.windowMs };
}

// SagaStore.list streams newest-updated first, so the stale sagas this detector wants
// arrive last: every poll walks the full set. Acceptable at demo scale; revisit with a
// state-filtered listing if a real host ever carries a deep saga history.
export async function detectStuckSagas(
  sagas: { list(): AsyncIterable<Saga> },
  now: number,
  options: { ageMs: number },
): Promise<ReadonlyArray<StuckSagaFinding>> {
  const found: StuckSagaFinding[] = [];
  for await (const saga of sagas.list()) {
    if (TERMINAL_SAGA_STATES.has(saga.state)) {
      continue;
    }
    const ageMs = now - saga.updatedAt;
    if (ageMs >= options.ageMs) {
      found.push({ signature: 'stuck-saga', saga, ageMs });
    }
  }
  return found;
}

const MISMATCH_METRIC = 'worker.checkpoint.verify';
const MISMATCH_LOG = 'worker.checkpoint.mismatch';

export function detectIntegrityMismatches(
  signals: SignalFeed,
  sinceExclusive: number,
): ReadonlyArray<IntegrityMismatchFinding> {
  return signals
    .since(sinceExclusive + 1)
    .filter(isMismatch)
    .map((signal) => ({
      signature: 'integrity-mismatch' as const,
      at: signal.at,
      channel: signal.source,
    }));
}

function isMismatch(signal: Signal): boolean {
  if (signal.source === 'meter') {
    return (
      signal.name === MISMATCH_METRIC && signal.tags.outcome === 'mismatch'
    );
  }
  return signal.name === MISMATCH_LOG;
}
