# Consumer Setup — Bridge subsystem

> Part of the [Consumer Setup](../CONSUMER-SETUP.md) reference, split out for focused reading. In-project coding agents get the same material (progressively disclosed) from the `bridge` skill under `.claude/skills/`.

## Bridge subsystem

The Event-to-Job Bridge (ADR-023, shipped 2026-04-22 via BRIDGE-1..9) is the
durable, typed, observable path from *event published* to *user job started*.
It is its own subsystem — combiner of events + jobs, owned by neither.

### Install

```bash
codegen subsystem install bridge
```

This runs `copyRuntime` to vendor `runtime/subsystems/bridge/` into your
project, drops a `generated/.gitkeep` under
`<paths.subsystems>/bridge/generated/` (where `just gen-all` will later write
`registry.ts`), and injects a `bridge:` block into `codegen.config.yaml`:

```yaml
bridge:
  backend: drizzle       # 'drizzle' (production) or 'memory' (tests)
  multi_tenant: false    # pair with BridgeModule.forRoot({ multiTenant: true })
```

Register the module in your `app.module.ts`:

```ts
BridgeModule.forRoot({ backend: 'drizzle', multiTenant: false }),
```

### Authoring triggers

Triggers are **job-owned**. Declare them on the `@JobHandler` decorator:

```ts
@JobHandler<SendWelcomeEmailInput>('send_welcome_email', {
  triggers: [
    {
      event: 'user.created',
      map: (e) => ({ userId: e.aggregateId, email: e.payload.email }),
      when: (e) => e.payload.email !== undefined,  // optional
    },
  ],
})
export class SendWelcomeEmailJob extends JobHandlerBase<SendWelcomeEmailInput> {
  // ...
}
```

`map:` and `when:` are typed TS callbacks — they get typechecked against
`PayloadOfType<'user.created'>`. They must be self-contained (no calls to
project helpers); the codegen inlines the arrow body verbatim into
`bridge/generated/registry.ts`. See the bridge skill
(`.claude/skills/bridge/SKILL.md`) for the full authoring contract.

Run `just gen-all` (or `codegen entity new --all`) to regenerate
`bridgeRegistry`. Unknown event types referenced in `triggers[].event` fail
the build at that point (ADR-023 §Decision 5).

### Wiring the reserved `events_*` pools

The bridge drain claims `domain_events` rows and inserts wrapper `job_run`
rows in the reserved `events_inbound` / `events_change` / `events_outbound`
pools. A worker process must actually *drain* those pools. The library exports
`BRIDGE_RESERVED_POOLS` (the three reserved pool *names*) — spread it into the
active-pools list of your `JobWorkerModule.forRoot`:

```ts
import { BRIDGE_RESERVED_POOLS } from '@shared/subsystems/bridge';
import { JobWorkerModule } from '@shared/subsystems/jobs';

JobWorkerModule.forRoot({
  mode: 'embedded',
  backend: 'drizzle',
  // active pool names this worker drains — include the reserved lanes:
  pools: ['interactive', 'batch', ...BRIDGE_RESERVED_POOLS],
}),
```

Pool *definitions* (concurrency per lane) live in `codegen.config.yaml` under
`jobs.pools`, not in `forRoot`; `JobWorkerModule.forRoot({ pools })` only names
which lanes this process drains. (Or `JobWorkerModule.forRoot({ allPools: true
})` to drain every pool including the reserved ones — what the standalone
`worker.ts` uses.) `BridgeModule.forRoot()` fails fast at boot if the reserved
pools aren't being polled. Wrappers are cheap (read ledger, evaluate `when:`,
call `orchestrator.start()`, update ledger) so the reserved lanes can run at
high concurrency safely. Too
low → bridge latency spikes under burst; too high → wastes DB connection
headroom. Set the reserved lanes' concurrency in `codegen.config.yaml` under
`jobs.pools` (a value around 32 is a safe default for these cheap wrappers);
tune per direction if measurements demand it.

**Never route user work into reserved pools.** Module init rejects a user
`@JobHandler` whose `pool:` is one of `events_*`. Wrappers live there; your
work lives in a pool you declare.

### Fanout discovery — `codegen events consumers <type>`

```bash
codegen events consumers user.created
```

Prints one greppable report with three tier sections + file:line citations:

```
Event: user.created
Tier 3 — Bridge triggers (2):
  - send_welcome_email#0     (src/jobs/send-welcome-email.job.ts:14)
  - provision_workspace#0    (src/jobs/provision-workspace.job.ts:18)
Tier 2 — Direct invoke via publishAndStart (1):
  - src/use-cases/signup.uc.ts:42
Tier 1 — Subscribers (1):
  - MetricsListener.onCreate @OnEvent('user.created') at src/observability/metrics.ts:28
```

Unknown event types (not in the generated `eventRegistry`) print a
suggestion-bearing warning to stderr but the command still exits 0.

If the AST scan finds zero `publishAndStart` call sites but `EventFlowService`
is present in the codebase, a fallback warning prints to stderr — the scan
may miss non-standard injection patterns (property injection, dynamic
dispatch). Grep for `publishAndStart` to verify Tier 2 fanout manually.

### When NOT to use the bridge

The bridge adds **2–3 outbox poll cycles** of latency (typical 1–3 s). If your
work needs request-path durability with lower latency, use the `IEventFlow`
facade directly:

```ts
constructor(private eventFlow: IEventFlow) {}

async signup(input: SignupInput, tx: Tx): Promise<void> {
  // Tier 2: same transaction as the caller; durable but runs off the next
  // poll cycle (~1 poll cycle, ~300ms-1s).
  await this.eventFlow.publishAndStart(
    'user.created',
    'provision_workspace',
    { userId: input.id },
    { tx },
  );
}
```

Decision table:

| Need | Tier | Pattern |
|---|---|---|
| Cheap in-process reaction (metrics, cache bust) | 1 | `@OnEvent('x.y')` or `IEventBus.subscribe` |
| Request-path durable, caller knows the job | 2 | `eventFlow.publishAndStart(...)` |
| Async fanout, decoupled authors, multiple handlers per event | 3 | `@JobHandler.triggers[]` (the bridge) |

### Ordering guarantee

**Default configuration gives parallelism, not ordering.** Two events of the
same type may be processed concurrently by the drain; same-aggregate
ordering is NOT guaranteed out of the box. Two knobs — pick the one that
matches your actual requirement:

1. **`jobs.pools.events_<direction>.concurrency = 1`** — *blunt*. Serializes
   **every** wrapper in that direction pool → serializes every bridge fanout
   for that direction end to end. Simplest config; highest throughput cost.
   Use when every event in the direction genuinely needs strict order.

2. **A `concurrency` key on the user job's `@JobHandler`** — *granular*. The
   `key` callback receives the job input. Example:

   ```ts
   @JobHandler<ProvisionInput>('provision_workspace', {
     concurrency: { key: (input) => input.accountId, collisionMode: 'queue' },
     triggers: [...],
   })
   ```

   Per-aggregate serialization; parallelism preserved across unrelated
   aggregates. Use when only same-aggregate ordering is required. This is
   the recommended default when ordering matters — it keeps throughput high.

See ADR-023 §*Ordering guarantee* for the full reasoning.

### Multi-tenancy

Pair the config flag with the module:

```yaml
bridge:
  backend: drizzle
  multi_tenant: true
```

```ts
BridgeModule.forRoot({ backend: 'drizzle', multiTenant: true }),
```

When on, three enforcement sites throw `MissingTenantIdError` if
`tenantId === undefined` (explicit `null` passes, for cross-tenant work):

- `EventFlowService.publishAndStart` (request-path entry, Tier 2)
- `BridgeDeliveryHandler.run` (wrapper entry, Tier 3)
- `DrizzleBridgeDeliveryRepo.insertDelivery` (write boundary)

Event metadata carries `tenantId` from `TypedEventBus` → the bridge threads
it into `job_run.tenant_id` on `orchestrator.start()`. Both the bridge config
and the events / jobs configs must agree.

### Trigger rename or removal

Renaming a `@JobHandler('<name>')` changes the generated `trigger_id`
(`<jobType>#<index>`). In-flight `pending` deliveries in `bridge_delivery`
with the old `trigger_id` become orphans:

- The wrapper handler detects a missing registry entry and marks the delivery
  `skipped` with `skip_reason='trigger_unregistered'`.
- No auto-migration, no replay. The row is terminal.

If you need the old deliveries to run under the new name, drain the queue
before deploying the rename (ADR-023 §*Trigger rename or removal*). Otherwise
accept the orphaned rows as an expected, visible-in-ledger consequence.

### Retention

`bridge_delivery` rows accumulate without bound in Phase 2 — there is no
sweeper yet. Retention sweep for `bridge_delivery` rows ships in BRIDGE-10
(#173) as a fast-follow. Until then, prune manually if the table grows.
