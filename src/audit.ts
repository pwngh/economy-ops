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

export type SignatureName =
  'deadlock-storm' | 'stuck-saga' | 'integrity-mismatch';

export type AuditPhase =
  'detected' | 'decided' | 'acted' | 'verified' | 'escalated';

export type AuditRecord = {
  at: number;
  signature: SignatureName;
  tier: 1 | 3;
  phase: AuditPhase;
  subject: string | null;
  detail: Record<string, unknown>;
};

export type AuditSink = (record: AuditRecord) => void;

// Prove reports carry bigint money fields JSON.stringify refuses; they encode as
// `{"$bigint":"..."}`, the same convention as the lab's operation journal.
const replacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? { $bigint: value.toString() } : value;

export function jsonlAuditSink(write: (line: string) => void): AuditSink {
  return (record) => {
    write(JSON.stringify(record, replacer));
  };
}
