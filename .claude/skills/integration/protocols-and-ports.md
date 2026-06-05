# Protocols and ports

The integration subsystem has five ports. Four of them are required for a
working run; one is optional. This file describes each port, what
authoring a custom implementation looks like, and where the design
decisions were made.

## `IChangeSource<T>` — the detection seam

The one port every integration adapter implements. Three detection modes
(poll / CDC / webhook) converge here; per-mode differences live in
`Change<T>` metadata.

```ts
interface IChangeSource<T> {
  readonly label: string;  // e.g. 'salesforce-poll-opportunity'
  listChanges(
    subscription: IntegrationSubscriptionView,
    cursor: unknown | null,
  ): AsyncIterable<Change<T>>;
}

interface Change<T> {
  externalId: string;
  operation: 'created' | 'updated' | 'deleted';
  record: T;                           // canonical shape — provider mapping happens in the adapter
  cursor: unknown;                     // typed internally; opaque at the seam
  source: 'poll' | 'cdc' | 'webhook';  // provenance for run-log audit
  dedupKey?: string;                   // CDC replay_id / webhook event_id when available
  providerChangedFields?: string[];    // CDC-only hint; skips deep-equal when set
}
```

**One adapter per `(provider, detection-mode, canonical-entity)` tuple.**
`SalesforcePollOpportunityChangeSource` is one class, 50-ish LOC over a
shared `PollingStrategyBase` helper. Don't write a monolithic adapter
that yields a discriminated union across entities — narrower scope
means one `label` per run-log row and better isolation.

**Cursor shape is opaque at the port.** The strategy types it
internally:
- Poll: `{ systemModstamp: string }` or `{ lastSyncedAt: string }`
- CDC: `{ replayId: number }`
- Webhook: `{ ts: number }` or `{ eventId: string }`

The orchestrator persists `change.cursor` as the iterator advances; it
does not interpret the shape.

**`providerChangedFields` is advisory.** When set (CDC providers that
tell you which columns changed), the differ can skip deep-equal over
untouched fields. Still filters through the ignore list — provider
hints don't override the ignore rules.

**Do not add mode-specific methods to `IChangeSource`.** The narrow
port is deliberate; the compromise analysis behind it is in epic #60.
If a new detection mode emerges, add a value to the `ChangeSource`
union and a metadata field if needed — not a new port.

## `IncrementalRead<T, F>` — the enumerate/hydrate read primitive (RFC-0003)

`IChangeSource.listChanges` is the right *transport* contract, but it imposes
no shape on the body that produces the changes — an empty `changeSources = {}`
seam invites the buffer-all/serial/run-final-cursor anti-pattern. `IncrementalReadBase`
(in `runtime/subsystems/integration/`, exported from `@pattern-stack/codegen/subsystems`)
fixes that: it owns the orchestration and the author fills exactly **three vendor methods**.

```ts
abstract class IncrementalReadBase<T, F = unknown, M = Record<string, unknown>>
  implements IncrementalRead<T, F>, IChangeSource<T>, RandomRead<T> {

  protected abstract enumerate(mode: ReadMode, filter?: F, pageSize?: number): AsyncIterable<Ref<M>[]>;
  protected abstract hydrate(ids: string[]): Promise<Map<string, unknown>>;   // keyed, miss-tolerant
  protected abstract toCanonical(raw: unknown): T | null;
}
```

- **`enumerate`** — the cheap delta/backfill walk. Stream *pages of refs* (id + per-ref
  `cursor` + filterable `meta`). LAZY: pull-driven, so `hydrate` backpressures it. Dispatch
  on `ReadMode`: `delta` (resume from `mode.cursor`), `full` (cursorless), `reconcile`
  (re-fetch `mode.knownIds` — the gap-repair pass).
- **`hydrate`** — the expensive batched fetch-by-id → `Map<id, raw>`. Write it over
  `mapConcurrent(ids, (id) => this.fetchOne(id), this.hydrateConcurrency)` (bounded parallel);
  override only for a real vendor `/batch` endpoint or a full-object-list passthrough. MUST be
  miss-tolerant (omit a mid-run 404 — never shift alignment).
- **`toCanonical`** — provider payload → canonical `T` (`null` drops the record).

The base PROVIDES `read()` (filter-before-hydrate, keyed pairing, per-ref cursor), `get()`
(`RandomRead`, free as `toCanonical ∘ hydrate([id])` — the "list cheaply, fill on click" atom),
and `listChanges()` (adapts `read()` → `Change<T>`).

**North star — dealbrain's HubSpot `canonical-adapter.listSince`.** CRM search returns full
objects, so it `async *`-streams, pushes the filter server-side (`filterGroups` + `GT`), and
carries a per-record `systemModstamp` cursor. The enumerate/hydrate split generalizes that to
vendors whose list returns id-stubs (Gmail `messages.list` → `messages.get`) or nested resources
(Meet `conferenceRecords` → `transcripts` → `entries`), where `hydrate` does the N+1 (bounded)
and full-object lists make `hydrate` a passthrough.

**Filter placement is structural (RFC-0003 §8 falsifier).** `read()` applies the filter
*before* `hydrate`, so an adapter physically cannot hydrate-then-discard. Two hooks, exactly
one live per `filterPushdown`:
- `matchesRef(ref, filter)` — **preferred**, pre-hydrate, when the vendor pushes the predicate
  down or exposes it in ref `meta`. Set `protected override filterPushdown = true`.
- `matchesRecord(record, filter)` — the **floor**, post-hydrate, when the vendor can do neither
  (Gmail without `q=`). Declared via `filterPushdown = false` — honest, not silent.

Either way the *emitted set is identical* (only hydration cost differs) — that's the falsifier
guarantee. Codegen threads `detection.filters` in as a static `ResolvedFilter[]` and
`filterFor()` returns it (`F = ResolvedFilter[]`).

**Cursor divisibility (§3).** `cursorDivisible` (from the cursor strategy `kind` via
`isDivisibleCursor`) controls cursor emission. *Divisible* (`systemModstamp`/`timestamp`/`replayId`):
each record carries its own cursor; a crash resumes from the last delivered ref. *Atomic*
(`historyId`/`syncToken` — the next token only exists at end-of-walk): per-ref cursors are
withheld and only the final record carries the token, so the orchestrator's persist-last-yielded
never persists an unresumable mid-walk value (resumes all-or-nothing; bound the backfill blast
radius with `ReadRequest.pageSize`).

**Per-connection auth + raw landing — `ReadContext` (R5).** `enumerate`/`hydrate`/`get`/`read`
take an optional `ctx?: ReadContext` carrying the run's `subscription`; `listChanges` builds
`{ subscription }` and threads it down. A **multi-account** provider (per-connection tokens, not
one provider-level token) resolves credentials in the fetch from `ctx?.subscription?.externalRef`
— assert its presence (`if (!ctx?.subscription) throw …`); a singleton change source can't hold
connection-scoped auth any other way. `ctx` is also the natural place to **land raw** (ADR-0001):
`hydrate` has both the raw payloads and `ctx.subscription.id`, so inject a raw-objects repo and
land there (only kept refs hydrate ⇒ only kept records' raw lands). Provider-level-auth adapters
ignore `ctx`. (Optional everywhere = the core contract; a direct `get(id)` "fill on click" may omit it.)

**Codegen emits the subclass.** For interaction surfaces, `codegen entity new --all` emits a
per-entity `IncrementalReadBase<Canonical<Entity>, ResolvedFilter[]>` subclass (emit-once,
author-owned) registered in the adapter's `changeSources` — you fill `enumerate`/`hydrate`/
`toCanonical`, never a raw `listChanges` loop.

## `IEntityChangeSourceRegistry` — entity-keyed source resolution

Resolves an `IChangeSource<T>` by entity name (`get<T>(name)`, `has`,
`entities()`), throwing `UnknownEntityError` on a miss. It generalizes the
per-entity `<ENTITY>_POLL_FETCH_REGISTRY` tokens into one registry so the L3
surface port stays entity-agnostic. Use `MemoryEntityChangeSourceRegistry`
(backed by a `Map`) for tests/simple wiring; bind under the
`ENTITY_CHANGE_SOURCE_REGISTRY` token. Codegen emission of the populated
registry is Track D (RFC-0001 §3); full authoring coverage lives in the C5
surface-authoring guide.

### Driving Track D codegen — there is no `provider`/`integration`/`gen` command

Provider + adapter emission is **a post-step of `codegen entity new`**, not a
standalone command. The CLI exposes no `provider`, `integration`, `surface`, or
`gen` verb — searching `--help` for one and finding nothing is expected, not a
publish gap. The wiring lives in `EntityNewCommand.execute()`
(`src/cli/commands/entity.ts`), after event/bridge/orchestration codegen.

To regenerate:

```bash
codegen entity new --all      # cdp is the alias bin; `just gen-all` wraps this
```

The step:

1. Looks for `definitions/providers/*.yaml` (override via `paths.providers` in
   `codegen.config.yaml`; default `definitions/providers`). **No providers dir ⇒
   the whole step is silently skipped** — the usual reason "nothing happened."
2. Runs the D1 cross-validator (slug/surface always; import-path check only when
   a consumer tsconfig resolves path aliases — this is the "`cdp gen` failing on
   bad import paths" seen in release notes). Blocking issues ⇒ nothing written.
3. Emits one provider module per YAML → `<backendSrc>/integrations/providers/`.
4. **Only if provider emission succeeded with zero issues**, runs `emitAdapters`
   → `<backendSrc>/integrations/` (emit-once author-owned scaffolds +
   `@generated` files). A provider surface with no Track C surface package is
   skipped with a warning, not an error.

The generated scaffold is the ground truth for the adapter's port shape: the
emitted `<Surface>Port` / `IChangeSource<T>` + registry wiring is what adapters
must implement — read it rather than inferring the shape from `.d.ts`.

## `IIntegrationSink<T>` — the write surface

One sink per canonical entity. Speaks canonical externally; internal
mapping stays inside.

```ts
interface IIntegrationSink<TCanonical> {
  findByExternalId(userId: string, externalId: string): Promise<TCanonical | null>;
  upsertByExternalId(userId: string, record: TCanonical, provider: string): Promise<{ id: string; saved: TCanonical }>;
  softDeleteByExternalId(userId: string, externalId: string): Promise<{ id: string } | null>;
}
```

**`findByExternalId` must return a canonical-shaped view of local state.**
The differ compares `existing` (from the sink) against
`change.record` (from the adapter) — mixing canonical and local shapes
makes every row look "changed." If the local row uses a different
column name or shape, project it inside the sink.

**`upsertByExternalId` owns the transactional envelope.** Canonical
columns, FK resolution (`account_id` from `accountExternalId`), EAV
dual-write (when the entity has `fields`), `user_id` + `provider`
stamping — all happen inside the sink's transaction. The subsystem
never reaches around the sink to write to local tables.

**Return the local id from `upsert`.** The orchestrator records it on
`integration_run_items.local_id` for later drill-down joins between the audit
log and the actual local row.

**Re-entry tolerance is the sink's job.** If the orchestrator sees the
same record twice in a window (a webhook retry, a polling overlap),
the sink's upsert must be idempotent — typically `ON CONFLICT
(external_id) DO UPDATE` with no-op semantics when the incoming record
equals the existing row.

## `ICursorStore` — cursor persistence

Subscription-addressed cursor storage.

```ts
interface ICursorStore {
  get(subscriptionId: string, tenantId?: string | null): Promise<unknown | null>;
  put(subscriptionId: string, cursor: unknown, tenantId?: string | null): Promise<void>;
}
```

**`put()` stamps `last_integration_at` + `updated_at` along with `cursor`** in
the Drizzle backend. The `(enabled, last_integration_at)` scheduling index
from SYNC-1 would be useless otherwise. If a dry-run / time-travel
use case ever emerges, the right move is a third argument, not
wrapping the port.

**`tenantId` is a signature arg, not a proxy layer.** SYNC-4 chose the
signature approach explicitly: multi-tenancy bugs are silent and
dangerous; explicit signatures catch omissions at the type boundary;
proxies hide who's enforcing. Matches JOB-8 / EVT-6 precedent. Memory
backend accepts + ignores; Drizzle enforces via `assertTenantId`.

**Do not instantiate `ICursorStore` inside a sink or adapter.** Always
inject via `INTEGRATION_CURSOR_STORE`. The orchestrator owns the `get/put`
lifecycle — call sites outside it invert the control flow.

## `IFieldDiffer<T>` — the diff seam

Pluggable differ; default ships as `DeepEqualDiffer<T>`.

```ts
interface IFieldDiffer<T> {
  diff(existing: T | null, incoming: T, providerChangedFields?: string[]): DiffResult;
}

type DiffResult = FieldDiff | 'noop';
type FieldDiff = { [fieldName: string]: { from: unknown; to: unknown } };
```

**Default `DeepEqualDiffer` ignore list** (row metadata sinks /
services stamp):
`id`, `createdAt`, `updatedAt`, `deletedAt`, `type`, `lastModifiedAt`,
`fields`, `providerMetadata`. `fields` is the EAV bag — it's diffed by
the sink's EAV dual-write path, not at the canonical-record layer.

**Normalizations applied during comparison (NOT in diff output):**

- `Date → toISOString()` — adapters deliver strings, sinks return
  `Date` from the DB driver. Normalize for comparison so they match.
- Decimal-string ↔ number — Postgres `numeric` returns as a string
  through Drizzle; adapters deliver numbers. When one side is numeric
  and the other is a finite-parseable string, they compare equal.
  Empty-string guard prevents silent 0-equality.

**Diff output preserves raw values.** When a field genuinely differs,
`{ from: Date, to: Date }` holds the raw Dates (not normalized ISO
strings). `JSON.stringify` round-trips through jsonb normalize on
persist; the audit stays faithful to the input.

**Augmenting the ignore list per entity:**

```ts
{ provide: INTEGRATION_FIELD_DIFFER, useValue: new DeepEqualDiffer({ ignore: ['integration_version'] }) }
```

`ignore` values are merged with the default set.

**Un-ignoring a default (`unignore`)** — the inverse knob. A normally-metadata
column can be domain data for a given entity: e.g. an entity with
`softDelete: false` whose `deletedAt` carries a vendor-observed retraction
tombstone on the canonical record. Without un-ignoring it the tombstone diffs to
`'noop'` and never lands. `unignore` removes the field from the ignore set
(subtracted after `ignore`, so it wins):

```ts
{ provide: INTEGRATION_FIELD_DIFFER, useValue: new DeepEqualDiffer({ unignore: ['deletedAt'] }) }
```

Or set it app-wide via config — `integration.differ.{ignore,unignore}` in
`codegen.config.yaml` threads into the default differ that
`IntegrationModule.forRoot` provides:

```yaml
integration:
  differ:
    unignore: [deletedAt]
```

**Writing a custom `IFieldDiffer<T>`** (e.g. a type-aware differ that
normalizes enums, or a CDC differ that only inspects hinted fields):
bind it to `INTEGRATION_FIELD_DIFFER` in the feature module. The orchestrator
calls `differ.diff(existing, incoming, change.providerChangedFields)`
once per record.

## `IIntegrationRunRecorder` — the audit write surface

```ts
interface IIntegrationRunRecorder {
  startRun(input: StartRunInput): Promise<{ id: string }>;
  recordItem(input: RecordItemInput): Promise<void>;
  completeRun(runId: string, input: CompleteRunInput): Promise<void>;
}
```

**`recordItem` validates `changedFields` via `FieldDiffSchema.parse`
BEFORE the write.** Both Drizzle and Memory backends do this. A
malformed shape throws a `ZodError` at the recorder boundary; the
orchestrator sees the validation failure, not a DB constraint error.

**`completeRun` does not re-check tenancy.** The run id was returned by
`startRun` which already enforced it; run ids are uuids not guessable
cross-tenant. Matches JOB-3's pattern. Do not add a tenancy guard in
`completeRun` without an ADR.

**Not shipping a per-entity recorder.** Dealbrain's bespoke recorder
had CRM-specific convenience methods (label resolution, entity-type
narrowing). The subsystem extracted the generic write path only; those
conveniences stay consumer-owned in a service layer above the recorder.

## `ILoopbackFingerprintStore<T>` — optional

Suppresses echoes of the local system's own outbound writes from the
next inbound poll/CDC/webhook.

```ts
interface ILoopbackFingerprintStore<T = unknown> {
  isEchoOfOwnWrite(entityType: string, externalId: string, record: T): Promise<boolean>;
}
```

**Not shipped by the subsystem in Phase 1.** Consumers with outbound
writeback paths provide their own (Redis-hashed with TTL shorter than
the poll interval, or in-memory for tests). `@Optional()` on the
orchestrator's inject means absence is fine — the check is skipped and
all changes are processed normally.

**`entityType` is `string` — no CRM narrowing.** Dealbrain's original
port leaked `'opportunity' | 'account' | 'contact'` into the seam;
HS-9 findings forced the fix before upstreaming. Don't re-introduce
the narrowing; consumers narrow internally if they want.
