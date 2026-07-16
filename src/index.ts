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

export { jsonlAuditSink } from './audit.ts';
export type {
  AuditPhase,
  AuditRecord,
  AuditSink,
  SignatureName,
} from './audit.ts';

export { opsRuntime } from './runtime.ts';
export type { OpsRuntime, Signal, SignalFeed } from './runtime.ts';

export {
  detectDeadlockStorm,
  detectIntegrityMismatches,
  detectStuckSagas,
} from './detect.ts';
export type {
  DeadlockStormFinding,
  Finding,
  IntegrityMismatchFinding,
  StuckSagaFinding,
} from './detect.ts';

export { createSupervisor, defaultSupervisorConfig } from './supervisor.ts';
export type {
  SagaSource,
  Supervisor,
  SupervisorConfig,
  SupervisorDeps,
} from './supervisor.ts';
