# Sync-Job Primitives: A→B Consolidated Design Brief

> Produced by the `jobs-kind-design-grounding` workflow (10 agents, 2026-06-13) grounding
> the request `.ai-docs/requests/job-primitives-and-codegen-jobs-kind.md` (swe-brain worktree).
>
> **A** = swe-brain (`/Users/dug/Projects/swe-brain/swe-brain`) — hand-built sync-job primitives.
> **B** = codegen-patterns (`/Users/dug/Projects/codegen-patterns`) — the future jobs definition kind + emitter that lifts A's shape.
> **Load-bearing contract:** a per-adapter sync-profile object (A config) **IS** a `JobDefinitionSchema` instance (B schema). A authors YAML; B compiles it.

---

## 1. Anchor verification verdict

Overall confidence: **HIGH.** 28 of 31 anchors confirmed. The research is sound and the plan holds. Three anchors drifted/refuted, and a handful of surprises matter — but **none invalidates a single design decision**; two of them actively *sharpen* the recommendations (the dedupKey/differ seam-split, and the inbound-sync cadence premise).

| Anchor | Cited | Verdict | What actually is | Plan impact |
|---|---|---|---|---|
| DetectionConfig discriminated on mode, per-mode cursor strategy, **`dedupKey`**, filters, mapping | `detection-config.schema.ts` | **DRIFTED** | Discriminant `mode` ✓; cursor union has **6** members (systemModstamp/replayId/timestamp/eventId/historyId/syncToken), not 4; **no `dedupKey` field exists at all** — it's a runtime `Change<T>` property derived from `webhook.eventIdField`/poll cursor. Header doc @17 is stale ("four shapes"). | **Reinforces D2 + D3.** Confirms dedupe lives on the *change source*, not config or differ. No field to lift into JobDefinitionSchema. |
| `inbound-sync` has a schedule cadence (implied: all 4 sync jobs scheduled) | (premise) | **REFUTED** | `inbound-sync` is **webhook-doorbell-driven, zero cadence**. Only reconcile-poll (1h), google-reconcile (1h), drive-poll (15m/+webhook) are scheduled. | **Reinforces D4.** A job has **0/1/N** triggers — cadence cannot live on the job. `triggers` must be a *list*. |
| `historyId`/`syncToken` cursor strategies; stale "four shapes" comment | `detection-config.schema.ts:17` | **DRIFTED (doc)** | Code has 6 cursor strategies; header comment lists 4. RFC-0003 added historyId+syncToken without updating the doc. | **Same-PR living-docs fix** when B touches the file. |

**Surprises that change nothing but belong in the ADR:**
- `JobHandlerMeta` has **8** fields, not 6 — claim omitted `scope` and `replayFrom`. The schema must surface all of them.
- `ScheduleSchema` is **duration/slot-based** (`every`/`align`/`catchUp`/`maxCatchUpSlots`), **no cron, no timezone**. Any text saying "cron" is wrong.
- The handlers are **composites of shapes**, not one-shape-each (reconcile-poll = PollSync channel-refresh sub-phase + ReconcileSync message sub-phase). Forces the multi-arm schema in §3.
- A **per-entity differ rebind already exists** at the DI layer (`INTEGRATION_FIELD_DIFFER`), so D2's "defer" has an escape hatch today with zero new surface.
- CDC is **provenance, not a mode** (`mode:'poll'` + `poll.provenance:'cdc'`). The `action:'cdc'` on the run input is a different axis.
- Codegen's ONLY `@JobHandler` touch is the **bridge-registry generator**, which scans authored `.ts` via the TS AST — *not* a jobs YAML loader. The jobs YAML gap is architectural intent, not oversight.

---

## 2. Resolved design decisions

| # | Decision | Call | Conf. | One-line rationale | Schema implication |
|---|---|---|---|---|---|
| **D1** | RealtimeSync = peer primitive vs webhook-drain mode | **Drain MODE** over the existing `webhook` change-source — **not** a 3rd primitive | High | `buildChangeSource` already has `poll\|webhook`; `WebhookChangeSource` is passive; claim/ack lives in the job handler; a single "realtime" run already mixes webhook + poll sources | **No new mode.** `DetectionConfigSchema` stays `discriminatedUnion('mode',[Poll,Webhook])`. Realtime arms reuse `mode:'webhook'`. |
| **D2** | Add per-run `differOverride` to `ExecuteIntegrationInput`? | **DEFER** (option c) | High | Dedupe/window lives on the *source* (`sourceOverride`), not the differ; the one cross-cutting need (`deletedAt`) is solved globally via `differ.unignore`; per-entity DI rebind covers the rest | **No change** to input type or schema. Fallback: add `differOverride?: IFieldDiffer<T>` mirroring `sourceOverride` only if a per-run need is proven. |
| **D3** | Adopt `DetectionConfigSchema` as profile backbone, or fresh? | **FRESH `JobDefinitionSchema`**, `DetectionConfig` **composed in per-arm** as read leaf | High | 0 of 8 requested profile fields exist in DetectionConfig; it's a single-source detection leaf (ADR-033) while a job is a multi-arm composite; W3 derivation-profile is the proven catalog-by-code + instances-by-data template | **Net-new** `src/schema/job-definition.schema.ts` + `definitions/jobs/` loader + emitter. `DetectionConfigSchema` **imported, not modified**. |
| **D4** | Where cadence lives | **Event-YAML `schedule:` wins** (ADR-039). **Option D**: profile carries an *optional read-only* `cadence` annotation codegen validates (drift-errors) vs the referenced event | High | Cadence is a property of the time-*event*, not the job; job→cadence is **0/1/N**; scheduler reads `eventRegistry`, never job defs | **No authoritative cadence field.** Profile references cadence via `triggers[].event`. Option D adds optional derived `cadence` + gen-time drift validator. |
| **D5** | How `inbound-sync` gets `(provider,domain)→use-case` | **Hand-build a throwaway LOCAL registry in A now** (option a); #458 is **not** a B blocker | High | Inputs already hand-injected; #458 is under-specified and entangled with #414/#457; the local registry *is the spec* for #458 | **None for B.** ~30-line A-side Nest provider. #458 stays a later additive emitter. |

### Decision interactions
- **D1 ↔ D3 (two discriminated unions at two altitudes).** Arm-kind `poll|reconcile|realtime` lives at the **job-arm** altitude *above* the `mode: poll|webhook` discriminator inside the embedded `DetectionConfig` leaf. A realtime arm carries `kind: realtime` *and* an embedded `read.mode: webhook`.
- **D2 ↔ D3 (one seam-split, two sides).** No `dedupKey` in config + global differ ⇒ `dedupe.unignore` on the profile is a **differ knob** (maps to `integration.differ.unignore`), not a DetectionConfig field and not a per-run differ. Cursor stays inside `DetectionConfig.poll.cursor` (6-member union).
- **D3 ↔ D4 (cadence is a reference, not a field).** Fresh schema gains `triggers[].event`; D4 forbids an authoritative cadence field. Consistent only because the schema is multi-arm with a trigger *list* — which the refuted inbound-sync premise independently forces.
- **D5 stands apart.** Touches no schema, gates nothing in B. Local registry must key by `(provider, domain)` from day one so #458 inherits the composite key (avoids the #414 entity-only-keying trap).

---

## 3. Proposed `JobDefinitionSchema` (B) / sync-profile shape (A)

> **SUPERSEDED as the authoritative contract by `docs/rfcs/RFC-0005-job-definition-kind.md` + `test/fixtures/jobs/*.yaml` (2026-06-14).** The schema landed with three resolutions this sketch glossed: the differ knob is `differ.unignore` (not `dedupe.unignore` — `dedupe` is the runtime DedupePolicy); the `lane` field is dropped (not a `JobHandlerMeta` field; lane = `pool`); function-valued fields are `{{template}}` strings. The inline YAML below is illustrative — it uses hyphenated `type` and field-less cursors that the schema (correctly) rejects. Author against the fixtures.

**The single most important artifact.** It reconciles all five decisions: two-altitude discriminated unions (D1+D3), embedded `DetectionConfig` leaf (D2+D3), trigger-list-not-cadence-field with optional drift-checked annotation (D4), zero registry surface (D5).

### Structural contract (annotated)

```
JobDefinition (top level)
├─ type            string           # job-type literal == @JobHandler('<type>')
├─ pool            string?          # JobHandlerMeta.pool — execution lane
├─ lane            string?          # logical lane (maps to pool config)
├─ scope           ScopeRef?        # JobHandlerMeta.scope  (DON'T omit — anchor surprise)
├─ retry           RetryPolicy?     # JobHandlerMeta.retry
├─ concurrency     ConcurrencyPolicy?
├─ timeoutMs       number?
├─ replayFrom      'scratch'|'last_step'|'last_checkpoint'?   # (DON'T omit — anchor surprise)
├─ dedupe          { unignore: string[] }?   # D2: DIFFER knob, NOT DetectionConfig, NOT per-run
│                                            #     maps to integration.differ.unignore
├─ triggers        Trigger[]        # D4: 0/1/N. The ONLY cadence linkage. NOT a cadence field.
│   └─ Trigger: { event: string,            # cross-ref'd vs generated eventRegistry at gen time
│                 cadence?: CadenceAnnotation }   # D4 Option D: OPTIONAL, READ-ONLY, drift-validated
│        CadenceAnnotation = { every: string, align?: bool }  # mirror of event schedule:, NON-authoritative
└─ arms            Arm[]            # D1+D3: the multi-arm composite. discriminated on `kind`.
    └─ Arm = discriminatedUnion('kind', [PollArm, ReconcileArm, RealtimeArm])

PollArm:        { kind:'poll',      domain, read: DetectionConfig }            # read.mode:'poll', cursor ADVANCES
ReconcileArm:   { kind:'reconcile', domain, window: { hours: number },        # windowed sourceOverride
                  read: DetectionConfig, cursorWithheld: true }               #   cursor WITHHELD, tombstone-infer
RealtimeArm:    { kind:'realtime',  domain, staging: { table, pushAccelerate? },
                  read: DetectionConfig }                                     # read.mode:'webhook', claim/ack drain

DetectionConfig (IMPORTED from runtime/subsystems/integration/detection-config.schema.ts — REUSED, NOT redefined)
  = discriminatedUnion('mode', [PollMode, WebhookMode])   # UNTOUCHED, ADR-033 intact
```

### Annotated YAML — `poll` case (`drive-poll`)

```yaml
# definitions/jobs/drive-poll.yaml
type: drive-poll
pool: integration
triggers:
  - event: document_poll_due          # → ScheduleSchema every:15m on the event YAML (authoritative)
    cadence: { every: 15m, align: true }   # D4 Option D: READ-ONLY mirror; codegen drift-errors if ≠ event
  - event: document_sync_due          # webhook doorbell — NO cadence (0/1/N triggers, anchor-confirmed)
arms:
  - kind: poll                        # D1: PollSync usage-shape over the `poll` change-source mode
    domain: document
    read:                             # D3: embedded DetectionConfig leaf — REUSED, not redefined
      mode: poll
      poll:
        cursor: { kind: systemModstamp }   # 6-member union (drift: not 4)
      mapping: [{ source: id, target: external_id }]
      filters: []
```

### Annotated YAML — `reconcile` case (`reconcile-poll`, composite)

```yaml
# definitions/jobs/reconcile-poll.yaml
type: reconcile-poll
pool: integration
dedupe:
  unignore: [deletedAt]               # D2: differ knob (== integration.differ.unignore), NOT per-run
triggers:
  - event: reconcile_due
    cadence: { every: 1h, align: true }    # D4: drift-validated mirror of reconcile_due.yaml schedule
arms:
  - kind: poll                        # composite arm #1: channel_refresh sub-phase (cursor advances)
    domain: channel
    read:
      mode: poll
      poll: { cursor: { kind: timestamp } }
      mapping: [{ source: id, target: external_id }]
  - kind: reconcile                   # composite arm #2: message_reconcile (windowed, cursor withheld)
    domain: message
    window: { hours: 24 }             # runtime windowStart = now − window; selects windowed sourceOverride
    cursorWithheld: true              # never regress the watermark (tombstone-inference source)
    read:
      mode: poll
      poll: { cursor: { kind: timestamp } }
      mapping: [{ source: ts, target: external_id }]
```

### Annotated YAML — `realtime` case (`inbound-sync`, drain mode, NO cadence)

```yaml
# definitions/jobs/inbound-sync.yaml
type: inbound-sync
pool: integration
# NO triggers cadence — webhook-doorbell-driven (anchor REFUTED the "scheduled" premise)
triggers:
  - event: message_received           # webhook doorbells; none carry schedule:
  - event: reaction_added
  - event: mail_sync_due
  - event: transcript_ready
arms:
  - kind: realtime                    # D1: webhook-DRAIN mode (NOT a peer primitive)
    domain: message
    staging:
      table: slack_message_staging    # consumer-owned staging table (package refuses to own it)
      pushAccelerate: true
    read:
      mode: webhook                   # D1: realtime REUSES mode:'webhook' — no new mode/case/subclass
      webhook: { eventIdField: client_msg_id }
      mapping: [{ source: externalId, target: external_id }]
  - kind: realtime
    domain: reaction
    staging: { table: slack_reaction_staging }
    read:
      mode: webhook
      webhook: { eventIdField: event_id }
      mapping: [{ source: externalId, target: external_id }]
  - kind: poll                        # Google doorbell arm: action:'webhook' but NO sourceOverride —
    domain: email                     #   DI-bound adapter walks the historyId cursor. Proves a single
    read:                             #   "realtime" run mixes webhook + poll → realtime can't be one primitive.
      mode: poll
      poll: { cursor: { kind: historyId } }   # 6-member union member added in RFC-0003
      mapping: [{ source: id, target: external_id }]
```

**Negative space that proves the decisions:**
- No third mode/arm-source primitive for realtime (**D1**).
- No `differOverride`, no per-run differ; `dedupe.unignore` is the only differ touchpoint, job-wide (**D2**).
- No widening of `DetectionConfigSchema` — imported verbatim (**D3**).
- No authoritative `schedule`/`every`/`cron` at job top level; cadence is a *reference* + optional drift-checked mirror (**D4**).
- No `(provider,domain)→use-case` registry surface — A-side throwaway (**D5**).

---

## 4. Dependency-ordered work breakdown (PR-sized)

Order: lock shared schema/ADR → build & behaviour-verify A primitives → B lifts the shape → npm auto-deploy gate → swe-brain dogfoods B (deletes hand-built primitives).

| # | [repo] Title | Scope | dependsOn | Size |
|---|---|---|---|---|
| **1** | [swe-brain] ADR-0018: sync-job primitives — 3 shapes, A→B contract | Lock taxonomy (Poll/Reconcile/Realtime as usage-shapes over poll/webhook modes), composition table, resolutions to D1–D5. Skeleton in §5. | — | M |
| **2** | [codegen] Lock `JobDefinitionSchema` shape + A→B contract doc | Agree §3 schema *on paper* (no emitter): arm-kind over source-mode, embedded DetectionConfig leaf, trigger-list, dedupe knob. RFC/spec only — the byte contract A builds against. | 1 | M |
| **3** | [swe-brain] D5: local `(provider,domain)→use-case` registry (THROWAWAY) | ~30-line Nest provider injecting the 8 use-case tokens; refactor `InboundSyncJobHandler` to `registry.get(provider,domain)`; keyed `(provider,domain)` to dodge #414. | — (independent) | S |
| **4** | [swe-brain] Behaviour-baseline the 4 sync handlers (golden tests) | Capture observable behaviour (cursor advance/withhold, tombstone counts, claim/ack drain, dual-trigger, no-cadence) as golden assertions **before** migration. The parity oracle for the B-lift. | 1, 3 | M |
| **5** | [codegen] Author `src/schema/job-definition.schema.ts` (fresh, imports DetectionConfig) | The Zod schema from §3. No loader/emitter yet — schema + unit tests against the 3 §3 YAML examples. Fix the stale `detection-config.schema.ts:17` header (living-docs). | 2 | M |
| **6** | [codegen] `definitions/jobs/` loader + `detectYamlType` 'jobs' branch | `loadJobs` in `yaml-loader.ts`; add `jobs` branch to `detectYamlType` (526–547); parser registry entry. Closes half the GAP. | 5 | M |
| **7** | [codegen] Job-handler emitter under `src/emitters/` + `entity new` post-step | Emit generated handler skeleton (arms → sourceOverride wiring, embedded DetectionConfig → change-source construction); wire `jobs` post-step in `entity.ts`. Define generated-skeleton vs AST-scanned authored `@JobHandler` coexistence. | 6 | L |
| **8** | [codegen] D4 cross-ref validator: `triggers[].event` → `eventRegistry`; Option-D cadence drift check | Reuse the bridge-registry generator's event-validation. Add optional read-only `cadence` + drift error. Update ADR-039 + events skill same PR. | 7 | M |
| **9** | [codegen] `just test-smoke-integration` green for the jobs emitter | Emitted-output-shape change MUST tsc-compile the emitted tree (project-memory gate). Gates the emitter PRs before release. | 7, 8 | M |
| **10** | 🚦 **[codegen] RELEASE GATE — `just bump` + main→npm auto-deploy of the jobs emitter** | **Explicit gated step.** Merging the bump to `main` auto-publishes. swe-brain consumes the *published* tarball, so the B-lift (#11) cannot start until the emitter is live on npm. Run `just test-post-publish` first; published versions are immutable. | 7, 8, 9 | S |
| **11** | [swe-brain] Author `definitions/jobs/*.yaml` for the 4 sync handlers (dogfood B) | Write the 4 profiles per §3 against the **published** codegen; generate; verify against #4 golden baseline. Migration is serialization, not redesign. | 4, 10 | L |
| **12** | [swe-brain] Delete A's hand-built primitives; collapse to generated wiring | Remove the copy-pasted shell (env-disable gate, connection resolve, re-declared `PhaseSummary` ×4); per-arm `sourceOverride` selection moves into generated arms. Behaviour-parity vs #4 must be green. | 11 | M |
| **13** | [codegen] **#458** — per-surface runtime `(provider,entity)→use-case` registry emitter | **SOFT-ordered, NOT a B blocker (D5).** After the dogfood; co-resolve #414 (composite key) + #457 (inbound event contract). Acceptance = #14. | 11 (soft) | L |
| **14** | [swe-brain] Delete the throwaway local registry; collapse 8 injections to `registry.get(...)` | #458's acceptance test: local registry removed, handler calls generated registry, smoke green. | 3, 13 | S |

**Critical-path note:** #10 is the only hard cross-repo serialization point — A's dogfood (#11) is gated on the npm publish, not on a checkout. After the §3 schema is locked on paper (#2), **A-build (#3,#4) and B-build (#5–#9) parallelize.** #13/#458 is explicitly *off* B's critical path.

---

## 5. ADR-0018 outline (swe-brain)

```
# ADR-0018: Sync-Job Primitives and the A→B Codegen Contract

## Status
Proposed — 2026-06-13. Supersedes the ad-hoc copy-pasted sync-handler shell.

## Context
- Four hand-authored sync JobHandlers (inbound-sync, reconcile-poll, google-reconcile,
  drive-poll) share a copy-pasted shell + a re-declared PhaseSummary struct ×4.
- Each handler is a COMPOSITE of source-usage shapes layered over the two change-source
  modes the codegen package owns (poll | webhook, switched in buildChangeSource).
- Jobs are code-first (@JobHandler self-registration); codegen has NO jobs YAML kind today
  (the verified GAP). Goal: lift the per-adapter sync profile into a codegen JobDefinition.

## The three shapes (usage-shapes, NOT three primitives — see D1)
| Shape        | Source behaviour                          | Cursor      | Mode     |
|--------------|-------------------------------------------|-------------|----------|
| PollSync     | DI-bound adapter walks delta              | ADVANCES    | poll     |
| ReconcileSync| windowed sourceOverride (now−window),     | WITHHELD    | poll     |
|              |   tombstone inference                     |             |          |
| RealtimeSync | webhook-staging sourceOverride, claim/ack | n/a (drain) | webhook  |

## Per-adapter composition table (handlers are composites)
| Handler          | Arms                                              | Cadence                  |
|------------------|---------------------------------------------------|--------------------------|
| drive-poll       | poll(document)                                    | 15m + webhook doorbell   |
| reconcile-poll   | poll(channel) + reconcile(message)                | 1h                       |
| google-reconcile | poll(mail) + poll(calendar) + reconcile(transcript)| 1h                      |
| inbound-sync     | realtime(message) + realtime(reaction) + poll(google)| NONE (webhook doorbells)|

## The A→B contract
- A per-adapter sync-profile object IS a B JobDefinitionSchema instance.
- A authors definitions/jobs/*.yaml; B (codegen) compiles them to handler skeletons.
- Cadence is NOT in the profile — it lives on the event YAML schedule: block (ADR-039);
  the profile references it via triggers[].event (+ optional drift-checked mirror).
- DetectionConfig is COMPOSED IN per read-arm (reused leaf), never adopted as backbone.

## Decisions (D1–D5)
- D1 — RealtimeSync is a webhook-DRAIN MODE, not a peer primitive.
- D2 — DEFER differOverride; global differ.unignore + per-entity DI rebind suffice.
- D3 — FRESH JobDefinitionSchema; compose DetectionConfig per-arm.
- D4 — Cadence stays on the event YAML (Option D drift-checked mirror).
- D5 — Throwaway local (provider,domain)→use-case registry now; #458 soft/later.

## Consequences
- New codegen surface: job-definition.schema.ts + definitions/jobs/ loader + emitter + post-step.
- DetectionConfigSchema and the entity detection: block UNTOUCHED (ADR-033 intact).
- swe-brain's no-detection stance preserved (adopts a JOB profile, not the detection contract).
- Living-docs: fix detection-config.schema.ts:17 ("four shapes"→six); ADR-039 + events skill
  note cadence is event-owned.

## References
- ADR-039 (time as an event source), ADR-033 (narrow DetectionConfig), ADR-023 (bridge),
  ADR-0016 (surface gate), #458/#414/#457, RFC-0003 (historyId/syncToken cursors).
```

---

## 6. Risks and watch-items

| Risk | Severity | Watch-item / mitigation |
|---|---|---|
| **Behaviour-parity drift in the A-lift** (composite handlers: cursor advance vs *withheld*, tombstone inference, claim/ack drain) | **High** | Land golden-baseline tests (#4) **before** migration; B-lift (#11/#12) diffs against them. `cursorWithheld` on the ReconcileArm is the highest-value invariant — a regressed watermark silently re-processes. |
| **npm auto-deploy coupling** (B-lift consumes the *published* tarball; main→npm is immutable) | **High** | Item #10 is an explicit gate. Run `just test-post-publish` + `just publish-ci --dry-run` first. Don't start #11 until the emitter version is live. A bad publish can't be unpublished — only superseded. |
| **Schema churn between A-build and B-lift** | **Medium** | Lock §3 on paper first (#2) and treat as the byte contract. Key the local registry `(provider,domain)` from day one. Freeze §3 before #11. |
| **Stale-doc landmines** (DetectionConfig "four"→six; ScheduleSchema is duration-based not cron; JobHandlerMeta 8 fields) | **Medium** | Any ADR/schema text saying "cron"/"timezone" is wrong. Surface all 8 JobHandlerMeta fields. Fix `detection-config.schema.ts:17` in the same PR (#5). |
| **inbound-sync premise REFUTED** (zero cadence; drive-poll dual triggers) | **Medium** | Schema MUST model `triggers` as a 0/1/N list, never a single cadence field. |
| **D1 realtime under-specification** (no single named codegen artifact; claim/ack stays hand-authored) | **Low** | Accept "realtime" is a usage pattern, not a 1:1 emitter output. Keep the staging table consumer-owned. |
| **Emitter/AST-seam coexistence** (generated skeleton vs bridge-registry's AST scan of authored `@JobHandler`) | **Medium** | #7 must define coexistence; the flat `jobs/` layout is load-bearing (generator scans only `<backend_src>/jobs`). Don't break the event→job bridge harvest. |
| **#458 entanglement leaking onto B's path** | **Low** (mitigated by D5) | Hold the line: #13/#458 is soft-ordered. The local registry (#3) *is* the spec. |
