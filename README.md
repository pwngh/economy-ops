# @pwngh/economy-ops

An in-process operations supervisor for
[`@pwngh/economy-lab`](https://github.com/pwngh/economy-lab): rule-based detection of
known incident signatures over the lab's `meter` and `logger` ports, one guarded
automatic remediation, and an append-only audit trail. It never writes ledger state.

## What it watches, and what it does

| Signature                                    | Response                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| MySQL deadlock storm (retry-pressure rule)   | Advisory only: names the known root cause and the known responses                                                  |
| Stuck payout saga (non-terminal past an age) | The one automatic action: a single worker sweep, cooldown-guarded, attempt-capped, verified by re-reading the saga |
| Integrity mismatch (checkpoint verify)       | Runs the read-only prover once, escalates with the report, stops — never auto-fixed                                |

Every detection, decision, action, and verification is written to a JSONL audit sink
the host injects. Guardrails are mandatory: per-saga cooldown, a per-saga attempt cap
that converts to a permanent escalation, and post-action verification.

## Wiring (the host composes both, side by side)

```ts
import {
  createSupervisor,
  jsonlAuditSink,
  opsRuntime,
} from '@pwngh/economy-ops';

const runtime = opsRuntime({ meter: yourMeter, logger: yourLogger, clock });

const caps = await capabilitiesFromEnv(env, ports, {
  clock,
  meter: runtime.meter, // forwards to yourMeter, feeds the detectors
  logger: runtime.logger, // forwards to yourLogger, feeds the detectors
});
const economy = economyFromCapabilities(caps);
const worker = createWorker(caps.store, workerCtxFrom(caps));

const supervisor = createSupervisor({
  clock,
  signals: runtime.signals,
  sagas: caps.store.sagas,
  runSweep: (now) => worker.runOnce({ now, limit: 10 }),
  audit: jsonlAuditSink((line) => appendToYourAuditLog(line)),
});
supervisor.start?.(60_000); // with a Scheduler; or drive supervisor.tick() yourself
```

The lab never imports this package and cannot tell it is being observed; leaving the
supervisor out of the composition is the off switch.

## Try it

```sh
npm test                 # includes the closed-loop acceptance + integrity tests
npm run demo             # the stuck-saga loop: detect, act, verify, audit
npm run demo:integrity   # a real ledger tamper: detect, prove, escalate — never fix
```

`PLAN.md` is the plan of record: the rulings, the three v1 signatures, and the paired
`economy-lab` changes this package's detection depends on.
