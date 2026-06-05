# ADR-033 — Config-Driven Change Sources

**Status:** Accepted
**Date:** 2026-04-25
**Owner:** Doug
**Related:** ADR-002 (domain-first module layout), ADR-008 (subsystem architecture)
**Amends:** ADR-002 — `IChangeSource<T>.listChanges` signature (cursor at the seam)
**Tracks:** Epic #226 (`pattern-stack/codegen-patterns`); plan at `ai-docs/specs/issue-226/plan.md`; decision memo locked at `/tmp/issue-226-decisions.md` (Q1–Q6)

> **Vocabulary note (2026-05-30, ADR-0005):** This ADR predates the `sync`→`integration` rename (shipped in 0.11.0). The "sync subsystem" / `sync_*` tables / `SYNC_*` tokens / `*-sync-source.module.ts` named below are now `integration` / `integration_*` / `INTEGRATION_*` / `*-integration-source.module.ts`. `IChangeSource<T>` and the change-source design are unchanged. See swe-brain `ADR-0005-rename-sync-to-integration` and the 0.11.0 CHANGELOG.

## Context

The Phase 1 sync subsystem (epic #60) shipped a single port — `IChangeSource<T>` — for every detection mode (poll / CDC / webhook), with per-mode differences carried on the `Change<T>` record (`source`, `dedupKey`, `providerChangedFields`). The design was deliberate: one orchestrator, three modes, one seam.

What it did not ship was a way to express the per-entity *configuration* that varies between adapters: which provider field maps to which canonical column, which filters apply at fetch time, which cursor strategy advances the stream, and (for webhook) which inbound staging field carries the dedup id. Today every consumer hand-authors a concrete `IChangeSource<T>` class per `(provider, detection-mode, canonical-entity)` tuple. Across one downstream codebase that is already four classes per provider × dozens of entities — boilerplate the YAML codegen layer should be emitting.

Epic #226 introduces three reusable primitives — `PollChangeSource<T>`, `WebhookChangeSource<T>`, and (deferred to #226-8) `StreamChangeSource<T>` — parameterized by a declarative `DetectionConfig` and a thin adapter callback that knows how to authenticate + fetch. The orchestrator stops caring whether a `Change<T>` came from a hand-written adapter or a configured primitive; the codegen layer emits a per-entity factory module that wires the right primitive to the consumer-registered adapter token.

This ADR locks the upstream Phase 1 contracts that make that future safe:

1. **Cursor at the port seam.** `IChangeSource<T>.listChanges` takes the cursor by value, not by injecting `ICursorStore` into the primitive.
2. **Loopback as middleware.** Loopback fingerprint suppression moves out of the orchestrator into a stock `ChangeMiddleware<T>` factory.
3. **DetectionConfig is the canonical shape.** A Zod schema in `runtime/subsystems/sync/` is the single source of truth for filter / mapping / cursor-strategy shape, consumed by both runtime primitives and the codegen YAML validator.

This PR (#226-1) lands items 1 (the protocol amendment, codified here in the ADR; the signature change ships in #226-2) and 3 (`DetectionConfigSchema` + `ChangeMiddleware<T>` types) plus the documentation that ties them together. The runtime primitives, loopback middleware migration, and codegen emission land in #226-3..#226-7.

## Decision

### 1. Detection is config, not code

Per-entity sync detection is a `DetectionConfig` value, not a hand-authored class. The schema is a discriminated union over `mode: 'poll' | 'webhook'` (see Q4 below for why CDC is not a top-level mode):

```ts
type DetectionConfig =
  | { mode: 'poll';    poll: { cursor: CursorStrategy; provenance?: 'poll' | 'cdc' };
                       mapping: FieldMapping[]; filters: ResolvedFilter[] }
  | { mode: 'webhook'; webhook: { eventIdField?: string };
                       mapping: FieldMapping[]; filters: ResolvedFilter[] };
```

> **Amendment (0.16.1, swe-brain ADR-0009 Amendment B §B5):** `webhook.eventIdField`
> is now **optional**, and the `WebhookFetchCallback` may yield an `eventId`
> alongside each record: `{ record: T; eventId?: string; cursor?: WebhookCursor }`.
> `WebhookChangeSource` derives `Change<T>.dedupKey` with the precedence
> **yielded `eventId` > `eventIdField` record extraction > undefined**. The yield
> is the right channel for vendor delivery metadata — an event id should never
> need a field on the vendor-neutral canonical record. It is also the safe channel
> when one canonical record identity (the `external_id`) can recur across distinct
> vendor events in a single drain batch: a message create and its later edit share
> one `external_id`, so an `eventIdField`-on-the-record substitution collapses them
> to one `dedupKey`; the yielded `eventId` keeps them distinct. Backward-compatible:
> callbacks that yield `{ record, cursor? }` and configs that set `eventIdField`
> are unchanged.

`CursorStrategy` is itself a tagged union over `systemModstamp | replayId | timestamp | eventId` — each variant names the field on the upstream record (or staging row) the strategy reads to advance the cursor.

`ResolvedFilter` is a flat `{ field, op, value }` triple with an enumerated operator vocabulary (`eq | neq | in | nin | gt | gte | lt | lte`). Richer boolean expressions (OR / NOT / nested) are deferred per the epic's open Q3; flat AND covers every requirement we have on the table today.

The schema lives at `runtime/subsystems/sync/detection-config.schema.ts` and is re-exported from the subsystem barrel, mirroring the `FieldDiffSchema` precedent.

### 2. Cursors pass through the port (amends ADR-002)

`IChangeSource<T>.listChanges` is amended from

```ts
listChanges(subscription: SyncSubscriptionView): AsyncIterable<Change<T>>;
```

to

```ts
listChanges(
  subscription: SyncSubscriptionView,
  cursor: unknown | null,
): AsyncIterable<Change<T>>;
```

The orchestrator already reads the prior cursor at `execute-sync.use-case.ts:137` (`cursorBefore`). Passing it through is one extra arg and removes the temptation for primitives to inject `ICursorStore` directly — which would create two readers of the same row and re-introduce the leak the skill rule "cursors are opaque at the port seam" was written to prevent (opacity is about *shape*, not *who reads*). Cursor lifecycle (advance-on-iterate, persist-on-success, transactional commit) stays orchestrator-owned.

This is a breaking change. Per CLAUDE.md "no backwards compat," every in-tree adapter and test fake updates in #226-2; no parallel old/new signature ships.

### 3. Loopback ships as middleware

The orchestrator's `@Optional() SYNC_LOOPBACK_FINGERPRINT_STORE` branch (`execute-sync.use-case.ts:253-271`) is deleted in #226-5. Loopback ships as `createLoopbackMiddleware(store: ILoopbackFingerprintStore<T>): ChangeMiddleware<T>`, composed into a primitive's middleware chain at construction. The `ILoopbackFingerprintStore<T>` *protocol* survives — only the orchestrator binding goes away.

`ChangeMiddleware<T>` is the universal composition seam:

```ts
type ChangeIterator<T> =
  (subscription: SyncSubscriptionView, cursor: unknown | null) => AsyncIterable<Change<T>>;

type ChangeMiddleware<T> = (next: ChangeIterator<T>) => ChangeIterator<T>;
```

The first middleware is the outermost layer (sees subscription/cursor first; sees yielded `Change<T>` last). The terminal `next` is the underlying `IChangeSource<T>.listChanges` bound to its instance. Middleware operates on the universal `Change<T>` shape, not per-mode metadata, so the same middleware works across poll / CDC / webhook primitives.

### 4. CDC is not a top-level mode

"CDC" is an umbrella over four mechanically different things:

| Substrate | Example | Shape |
|---|---|---|
| Cursor-based event endpoint | Stripe `/events?starting_after=…` | A poll with `event_id` cursor |
| Long-lived gRPC stream | SFDC Pub-Sub API | `subscribe(onChange)` lifecycle |
| Log-shipping consumer | Debezium → Kafka | Streaming consumer |
| Postgres logical replication | `wal2json` | Streaming consumer |

The first is mechanically `PollChangeSource<T>` with `provenance: 'cdc'` — the only difference from a stock poll is that emitted changes carry `Change<T>.source = 'cdc'` and `dedupKey` from the cursor field. The other three need a fundamentally different primitive (`subscribe(onChange, onError)`, ack-on-yield, server-paced backpressure, reconnect lifecycle) and are deferred to `#226-8` until a real consumer migrates onto upstream.

Treating CDC as a generic mode therefore over-promises. The schema lets `mode: 'poll'` opt into `provenance: 'cdc'` for the cursor-based-event-endpoint case and reserves a separate primitive for genuine streaming.

### 5. `SyncSubscriptionView` stays three fields

Per-subscription filter overrides are out of scope. Filters are set at primitive construction (from the per-entity YAML `detection.filters`); per-tenant divergence is achievable today by binding distinct `PollChangeSource<T>` instances per tenant. Adding `jsonb config` to `sync_subscriptions` is a real schema migration on a subsystem-owned table (sync skill rule 9) for which we have zero requirements; pre-emptive design violates CLAUDE.md "architectural correctness only."

### 6. `PollFetchContext` drops run-scoped fields

The poll-primitive adapter callback receives:

```ts
type PollFetchContext = {
  subscription: SyncSubscriptionView;
  cursor: PollCursor | null;
  filters: ResolvedFilter[];
};
```

`userId` / `tenantId` are *run-scoped* (they arrive on `ExecuteSyncUseCase.execute(input)`, not on the source). Threading them through the port forces signature expansion every time run context grows. Adapter closures own provider auth lookup — the consumer registers a `PollFetchCallback<T>` against a token, and that callback closes over whatever services it needs.

`T` in `PollFetchCallback<T>` is the entity/domain type — the persisted Drizzle row's TS type. Wire-format conversions (ISO-string → Date, decimal-string → number, etc.) happen via `DetectionConfig.mapping[].transform` before the callback's record reaches `Change<T>`; consumers do not maintain a parallel canonical TS type. See ADR-033.1 §10 for the full rationale.

### 7. Per-entity YAML, generated factory module

The `detection:` block lives in per-entity YAML (`entities/<entity>.yaml`). `codegen.config.yaml: sync:` keeps subsystem-wide settings only (backend, multiTenant, schema/config paths). The per-entity factory module emitted by Phase 2 codegen looks like:

```ts
@Module({
  providers: [
    {
      provide: SYNC_CHANGE_SOURCE,
      useFactory: (adapter: PollFetchCallback<Opportunity>) =>
        new PollChangeSource<Opportunity>({
          adapter,
          config: opportunityDetectionConfig,
          middlewares: [createLoopbackMiddleware(loopbackStore)],
        }),
      inject: [OPPORTUNITY_POLL_ADAPTER],
    },
  ],
})
export class OpportunitySyncSourceModule {}
```

Adapter-callback tokens (`OPPORTUNITY_POLL_ADAPTER` here) are consumer-registered. The codegen factory composes the locked middleware list and binds to `SYNC_CHANGE_SOURCE`.

`Opportunity` here (and the `T` parameter generally) is the entity type. `mapping[].transform` is the seat for any wire→entity field conversion the consumer needs — the change-source primitive applies the mapping before yielding `Change<T>` to the orchestrator. See ADR-033.1 §10.

## Rationale (Q1–Q6 cross-reference)

- **Q1 — Cursor at the port seam.** Decision §2 above. Memo locks option (a) — by-value pass-through — over (b) injecting `ICursorStore` into primitives. Rationale: avoids dual readers; preserves orchestrator-owned cursor lifecycle.
- **Q2 — Loopback collision.** Decision §3 above. Two loopback sites (orchestrator + adapter) collapse into one (middleware). `ILoopbackFingerprintStore<T>` protocol survives; orchestrator DI binding goes away. CLAUDE.md "no backwards compat" applies — replace cleanly, no parallel branch.
- **Q3 — `subscription.config` for filters.** Decision §5 above. `SyncSubscriptionView` stays three fields; per-tenant filter divergence achieved by binding distinct primitive instances per tenant.
- **Q4 — DetectionConfig schema location.** Decision §1 above. Schema lives in `runtime/subsystems/sync/`; codegen imports from runtime, not vice versa. Mirrors `FieldDiffSchema` precedent (`index.ts:34-36`).
- **Q5 — Adapter-callback signature.** Decision §6 above. `PollFetchContext` carries `subscription / cursor / filters`; run-scoped fields close over the callback at construction.
- **Q6 — Phase 2 codegen scope.** Decision §7 above. `detection:` lives per-entity in YAML; `codegen.config.yaml: sync:` stays subsystem-wide; factory module emitted per-entity.

## Consequences

**Positive:**
- One protocol amendment (#226-2) unblocks three primitives + one middleware factory + a generated factory module — five PRs that consume the locked seam without further protocol surgery.
- The `DetectionConfig` schema is the canonical shape: runtime primitives parse it at construction; the codegen YAML validator imports the same schema; drift between the two sites is a compile error rather than a runtime mismatch.
- Loopback-as-middleware aligns sync with the broader middleware-chain idiom — operators learn one pattern, not two (orchestrator branch + adapter pre-filter).

**Negative / costs:**
- `IChangeSource<T>.listChanges` is a breaking signature change. Every in-tree adapter + test fake updates in #226-2; downstream consumers re-write their adapter shells. Mitigation: per CLAUDE.md "no backwards compat," replace cleanly; coordinate via downstream channel before #226-5 merges.
- Removing `SYNC_LOOPBACK_FINGERPRINT_STORE` from the orchestrator DI graph breaks any in-flight downstream experiment we don't see. Mitigation: ship `createLoopbackMiddleware` factory + migration note in `docs/guides/integration-migration.md` (renamed from `sync-migration.md` per ADR-0005) in the same PR (#226-5).
- The schema's flat-AND filter vocabulary is deliberately lean. Consumers that need richer expressions (OR / NOT / nested) will reopen Q3 once a concrete requirement surfaces; speculative richness is rejected here.
- Long-lived streaming CDC (SFDC Pub-Sub, Debezium) is deferred. Consumers on those substrates today keep their hand-authored `IChangeSource<T>` until #226-8 lands. Acceptable: the streaming primitive's shape (gRPC lifecycle, ack contracts, backpressure) should be informed by a real consumer's requirements, not guessed.

**Out of scope of this ADR (and epic #226 generally):**
- Downstream consumer migration (separate downstream issue blocked-by #226-7's merge).
- Mode fallback semantics (e.g. CDC-with-poll-backstop) — deferred per the epic's open Q2.
- Filter expression vocabulary beyond flat AND.
- Inbound webhook staging-table schema — gated on ADR-002 §Phase 4 (consumer-owned).
- `StreamChangeSource<T>` for long-lived subscription substrates (#226-8 placeholder).

## Implementation map

| Issue | Lands |
|---|---|
| **#226-1 (this PR)** | This ADR; `detection-config.schema.ts`; `sync-middleware.protocol.ts`; barrel re-exports; schema unit tests |
| #226-2 | `IChangeSource<T>.listChanges(subscription, cursor)` signature change + every in-tree adapter / test fake |
| #226-3 | `PollChangeSource<T>` primitive + unit tests; `PollFetchContext` drops `userId` / `tenantId` |
| #226-4 | `WebhookChangeSource<T>` + `poll.provenance: 'cdc'` knob honored by `PollChangeSource<T>` |
| #226-5 | `createLoopbackMiddleware(store)` factory; orchestrator's loopback branch + token export removed |
| #226-6 | Entity-YAML `detection:` block validated against `DetectionConfigSchema` (no codegen yet) |
| #226-7 | Per-entity `<entity>-sync-source.module.ts` factory emission + baseline snapshot |
| #226-8 (deferred) | `StreamChangeSource<T>` for long-lived subscription substrates |
