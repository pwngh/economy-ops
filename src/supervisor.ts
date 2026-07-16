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
  detectDeadlockStorm,
  detectIntegrityMismatches,
  detectStuckSagas,
} from './detect.ts';

import type { Clock, Saga } from '@pwngh/economy-lab';
import type { Scheduler } from '@pwngh/economy-lab/ports';
import type { AuditPhase, AuditRecord, AuditSink } from './audit.ts';
import type { StuckSagaFinding } from './detect.ts';
import type { SignalFeed } from './runtime.ts';

export type SagaSource = {
  list(): AsyncIterable<Saga>;
  load(id: string): Promise<Saga | null>;
};

export type SupervisorConfig = {
  stuckSagaAgeMs: number;
  actionCooldownMs: number;
  maxActionAttempts: number;
  deadlockMetric: string;
  deadlockWindowMs: number;
  deadlockThreshold: number;
};

export const defaultSupervisorConfig: SupervisorConfig = {
  stuckSagaAgeMs: 300_000,
  actionCooldownMs: 60_000,
  maxActionAttempts: 3,
  deadlockMetric: 'engine.retry',
  deadlockWindowMs: 60_000,
  deadlockThreshold: 20,
};

export type SupervisorDeps = {
  clock: Clock;
  signals: SignalFeed;
  sagas: SagaSource;
  runSweep: (now: number) => Promise<unknown>;
  audit: AuditSink;
  prove?: () => Promise<unknown>;
  escalate?: (record: AuditRecord) => void;
  config?: Partial<SupervisorConfig>;
};

export type Supervisor = {
  tick(): Promise<ReadonlyArray<AuditRecord>>;
  start?(intervalMs: number): () => void;
};

type SagaActionState = {
  attempts: number;
  lastActedAt: number;
  escalated: boolean;
};

type SupervisorState = {
  perSaga: Map<string, SagaActionState>;
  stormReportedAt: number;
  mismatchHandledUpTo: number;
};

type Pass = {
  deps: SupervisorDeps;
  config: SupervisorConfig;
  state: SupervisorState;
  now: number;
  emit: (record: AuditRecord) => void;
};

export function createSupervisor(
  deps: SupervisorDeps,
  scheduler?: Scheduler,
): Supervisor {
  const config = { ...defaultSupervisorConfig, ...deps.config };
  const state: SupervisorState = {
    perSaga: new Map(),
    stormReportedAt: Number.NEGATIVE_INFINITY,
    mismatchHandledUpTo: Number.NEGATIVE_INFINITY,
  };
  // Overlapping ticks would both decide to act before either records its cooldown, so a
  // tick that arrives while one is still running is skipped, not queued.
  let inFlight = false;
  const tick = async (): Promise<ReadonlyArray<AuditRecord>> => {
    if (inFlight) {
      return [];
    }
    inFlight = true;
    try {
      const now = deps.clock.now();
      const out: AuditRecord[] = [];
      const pass: Pass = {
        deps,
        config,
        state,
        now,
        emit: (record) => {
          deps.audit(record);
          out.push(record);
        },
      };
      await runIntegrityPass(pass);
      runStormPass(pass);
      await runStuckSagaPass(pass);
      return out;
    } finally {
      inFlight = false;
    }
  };
  if (scheduler === undefined) {
    return { tick };
  }
  return {
    tick,
    start: (intervalMs) =>
      scheduler.every(intervalMs, async () => {
        await tick();
      }),
  };
}

async function runIntegrityPass(pass: Pass): Promise<void> {
  const { deps, state, now, emit } = pass;
  const findings = detectIntegrityMismatches(
    deps.signals,
    state.mismatchHandledUpTo,
  );
  if (findings.length === 0) {
    return;
  }
  emit({
    at: now,
    signature: 'integrity-mismatch',
    tier: 3,
    phase: 'detected',
    subject: null,
    detail: {
      signals: findings.length,
      channels: [...new Set(findings.map((finding) => finding.channel))],
    },
  });
  const proof = await runProver(deps);
  const escalation: AuditRecord = {
    at: now,
    signature: 'integrity-mismatch',
    tier: 3,
    phase: 'escalated',
    subject: null,
    detail: { proof },
  };
  emit(escalation);
  deps.escalate?.(escalation);
  state.mismatchHandledUpTo = findings.reduce(
    (max, finding) => Math.max(max, finding.at),
    state.mismatchHandledUpTo,
  );
}

async function runProver(deps: SupervisorDeps): Promise<unknown> {
  if (deps.prove === undefined) {
    return null;
  }
  try {
    return await deps.prove();
  } catch (error) {
    return { proverFailed: String(error) };
  }
}

const DEADLOCK_ADVISORY =
  'Known signature: InnoDB gap locks on the idempotency claim under concurrent ' +
  'submits. Confirm against the engine deadlock counters ' +
  '(performance_schema on MySQL, pg_stat_database on Postgres), then reduce ' +
  'submit concurrency or shard the hot platform accounts; the retry budget ' +
  'absorbs the storm in the meantime.';

function runStormPass(pass: Pass): void {
  const { deps, config, state, now, emit } = pass;
  if (now - state.stormReportedAt < config.deadlockWindowMs) {
    return;
  }
  const storm = detectDeadlockStorm(deps.signals, now, {
    metric: config.deadlockMetric,
    windowMs: config.deadlockWindowMs,
    threshold: config.deadlockThreshold,
  });
  if (storm === null) {
    return;
  }
  emit({
    at: now,
    signature: 'deadlock-storm',
    tier: 3,
    phase: 'detected',
    subject: null,
    detail: { retries: storm.retries, windowMs: storm.windowMs },
  });
  emit({
    at: now,
    signature: 'deadlock-storm',
    tier: 3,
    phase: 'decided',
    subject: null,
    detail: { decision: 'advise', advisory: DEADLOCK_ADVISORY },
  });
  state.stormReportedAt = now;
}

async function runStuckSagaPass(pass: Pass): Promise<void> {
  const { deps, config, state, now, emit } = pass;
  const findings = await detectStuckSagas(deps.sagas, now, {
    ageMs: config.stuckSagaAgeMs,
  });
  const actionable: StuckSagaFinding[] = [];
  for (const finding of findings) {
    const id = finding.saga.id;
    emit(
      stuckRecord(now, 'detected', id, {
        state: finding.saga.state,
        ageMs: finding.ageMs,
      }),
    );
    const action = state.perSaga.get(id) ?? {
      attempts: 0,
      lastActedAt: Number.NEGATIVE_INFINITY,
      escalated: false,
    };
    state.perSaga.set(id, action);
    if (action.escalated) {
      emit(
        stuckRecord(now, 'decided', id, {
          decision: 'suppressed',
          reason: 'escalated',
        }),
      );
    } else if (action.attempts >= config.maxActionAttempts) {
      action.escalated = true;
      const escalation = stuckRecord(now, 'escalated', id, {
        attempts: action.attempts,
        state: finding.saga.state,
      });
      emit(escalation);
      deps.escalate?.(escalation);
    } else if (now - action.lastActedAt < config.actionCooldownMs) {
      emit(
        stuckRecord(now, 'decided', id, {
          decision: 'suppressed',
          reason: 'cooldown',
        }),
      );
    } else {
      emit(
        stuckRecord(now, 'decided', id, { decision: 'act', action: 'runOnce' }),
      );
      actionable.push(finding);
    }
  }
  if (actionable.length > 0) {
    await actOnStuckSagas(pass, actionable);
  }
}

// One sweep serves every actionable saga: the worker advances all time-due work in a
// single pass, and per-saga targeting deliberately does not exist in the lab.
async function actOnStuckSagas(
  pass: Pass,
  actionable: ReadonlyArray<StuckSagaFinding>,
): Promise<void> {
  const { deps, state, now, emit } = pass;
  const ids = actionable.map((finding) => finding.saga.id);
  let failure: string | null = null;
  try {
    await deps.runSweep(now);
  } catch (error) {
    failure = String(error);
  }
  emit({
    at: now,
    signature: 'stuck-saga',
    tier: 1,
    phase: 'acted',
    subject: null,
    detail:
      failure === null
        ? { action: 'runOnce', sagas: ids }
        : { action: 'runOnce', sagas: ids, failure },
  });
  for (const finding of actionable) {
    const action = state.perSaga.get(finding.saga.id);
    if (action === undefined) {
      continue;
    }
    action.attempts += 1;
    action.lastActedAt = now;
    const after = await deps.sagas.load(finding.saga.id);
    const progressed =
      after !== null &&
      (after.state !== finding.saga.state ||
        after.updatedAt !== finding.saga.updatedAt);
    emit(
      stuckRecord(now, 'verified', finding.saga.id, {
        outcome: progressed ? 'progressed' : 'unchanged',
        from: finding.saga.state,
        to: after?.state ?? null,
        attempts: action.attempts,
      }),
    );
  }
}

function stuckRecord(
  at: number,
  phase: AuditPhase,
  subject: string,
  detail: Record<string, unknown>,
): AuditRecord {
  return { at, signature: 'stuck-saga', tier: 1, phase, subject, detail };
}
