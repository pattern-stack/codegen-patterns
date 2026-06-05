# ACTIVITY-SUBJECT-1 — config-driven subject scoping for the Activity pattern

**Status:** Draft — ready to build (bounded; library pattern + runtime base + tests)
**Date:** 2026-06-04
**Version:** 0.17.0 (minor — new pattern config surface + runtime base signature change)
**Origin:** swe-brain dogfood (second consumer of `@pattern-stack/codegen`). swe-brain's
ADR-0006 models interactions (meeting, email, transcript, message) as referencing
*subjects* (`person`, later `repo`/`team`) — the Salesforce Activities-vs-Records
shape. The library's `ActivityPattern` bakes the CRM term "opportunity" into the
shared base class, so the only subject-scoped finders it ships are
`findByOpportunityId` / `findRecentByOpportunityId`.
**Related:** ADR-031 (App-Defined Patterns — `configSchema` + `patternConfig` hand-off),
ADR-005 (superseded family base classes), CREATE-DTO-1 / LISTEN-NOTIFY-1 (house spec format).

---

## Problem

`src/patterns/library/activity.pattern.ts` and its runtime base classes hardcode CRM
vocabulary:

- `ActivityPattern.repositoryInheritedMethods` / `serviceInheritedMethods` advertise
  `findByOpportunityId, findRecentByOpportunityId`.
- `runtime/base-classes/activity-entity-repository.ts` implements those two against the
  literal column `this.table['opportunityId']`, and orders recency by the literal
  `this.table['occurredAt']`.
- `runtime/base-classes/activity-entity-service.ts` mirrors them
  (`findByOpportunity`, `findRecent`).

"Opportunity" is a CRM-ism. An activity/interaction entity is scoped to *some subject*,
and which subject is a per-entity fact, not a library constant. The pattern should let a
consumer declare the subject and get subject-scoped finders accordingly — for swe-brain,
`{ Activity: { subject: person } }` → finders scoped to `person_id`.

## Consumer census (settled before designing compat)

Searched both dogfood consumers' entity YAML and source:

| Consumer | `pattern: Activity` / `family: activity` | `ActivityEntityRepository` extends | `findByOpportunityId` from the pattern |
|---|---|---|---|
| dealbrain-integrations (main tree) | **zero** entity YAML — patterns in use are `Synced`, `Base`, `Metadata` | none — the `src/shared/base-classes/activity-entity-*.ts` are dead vendored library copies | none. The one `findByOpportunityId` in `src/modules/opportunity_contacts/` is a **`JunctionSyncRepository`** hand/declarative method, not the Activity pattern |
| swe-brain | **zero** — interaction entities are all `pattern: Integrated` / `pattern: Base` | none | none |

**Result: no consumer uses the Activity pattern.** Per CLAUDE.md ("no backwards
compatibility until we have users"), this is a **clean cut**: the CRM-named finders are
**deleted**, not aliased. The header comment claiming the method strings must stay
"byte-identical" to the legacy `FAMILY_MAP` was a one-time PATTERN-5 *migration*
guarantee (the `family:`→`pattern:` swap had to produce identical output); it is **not**
a standing contract once `family:` is gone and no fixture depends on the old strings.
The byte-identical baseline test (`prompt-extension.test.ts` "base-class output is
byte-identical to the pre-PATTERN-5 FAMILY_MAP") asserts only `Integrated` today and is
unaffected; we update the Activity expectations in the PATTERN-5 suite.

## Design decisions

### D1 — Generic `findBySubjectId`, not named `findByPersonId` (the load-bearing call)

The runtime base class is generic over `TEntity` and is defined once, at library build
time — it **cannot** know the subject name. The subject FK column is therefore read from
per-entity config at runtime, exactly as `IntegratedEntityRepository` reads
`this.integrationConfig` (the established ADR-031 §4 `patternConfig` hand-off). That
makes a **generic** finder the natural fit:

```ts
findBySubjectId(subjectId: string): Promise<TEntity[]>
findRecentBySubjectId(subjectId: string, limit = 10): Promise<TEntity[]>
```

Tradeoff recorded:

- **Generic (chosen).** One method, zero new codegen surface (config rides the existing
  `patternConfig` emission). Forward-compatible with **multi-subject** interactions
  (ADR-0006: a meeting references person + repo + team) — a later `findBySubjectId(type,
  id)` overload extends this without a combinatorial explosion of named methods. Reads
  slightly less naturally than `findByPersonId`.
- **Named (`findByPersonId`, rejected as the base method).** Reads better, but the
  runtime base can't generate per-config method *names*; achieving it would require the
  template to emit method *bodies* into every concrete repo — a large codegen change for
  marginal readability, and it does not generalize to multi-subject. Consumers who want
  a named finder already have the declarative `queries:` block
  (`queries: [{ by: [person_id] }]` → `findByPersonId`); that is the right surface for
  named, entity-specific finders, and it composes with this pattern.

### D2 — `findByUserId` stays as-is

`user_id` is **actor/owner** scoping, not subject scoping — generally applicable across
domains (every audited entity that has an owner uses `user_id`). It is not CRM-shaped.
Keep `findByUserId` / `findByUser` unchanged on the Activity base.

### D3 — Subject FK column derives from config, with an explicit override

The base resolves the FK column in this order, then camelCases it for `this.table[...]`:

1. `patternConfig.subjectColumn` — explicit snake_case column name, when the FK does not
   follow the convention.
2. `<patternConfig.subject>_id` — derived (e.g. `subject: person` → `person_id`).

If neither is present, `findBySubjectId` / `findRecentBySubjectId` throw a clear runtime
error naming the entity-config key to set. (Pattern entities that only want
`findByDateRange` / `findByUserId` simply never call the subject finders; the throw is
lazy, so a date/user-only Activity entity needs no subject config.) The recency ordering
column is `patternConfig.occurredAt` (snake_case) → camelCase, defaulting to
`occurred_at` → `occurredAt`.

### D4 — Composition with `Integrated` is valid; subject finders follow base resolution

`patterns: [Integrated, Activity]` is the swe-brain composition target (interactions are
`Integrated`). Composition validation must pass (no column/method conflict — Activity
contributes **no columns**; `subject_id` is an entity-declared FK, and `findBySubjectId`
does not collide with any `Integrated` method). The existing single-base rule
(`resolvePatternBaseClasses` uses `patterns[0]`) stands: with `Integrated` first, the
base class is `IntegratedEntityRepository` and the Activity subject finders are **not**
inherited — the consumer reaches subject scoping via the `queries:` block (D1). With
`Activity` first (or `pattern: Activity`), the base is `ActivityEntityRepository` and the
generic finders are inherited. This matches the documented Phase-1 limitation in
`resolvePatternBaseClasses` ("subsequent patterns contribute columns + implied behaviors
but do not change the base class") — multi-base mixin is out of scope here and unneeded:
the entire point of the composition is that the entity is `Integrated` *and* carries the
subject config for downstream tooling, not that it inherits two runtime bases. A
composition test locks that it validates clean and that `Integrated` wins the base.

### D5 — Config flows through the existing `patternConfig` property; no new template locals

`ActivityPattern` gains a `configSchema`. The clean-lite-ps repository/service templates
already emit `protected override readonly patternConfig = {...} as const` for any pattern
that has a `configSchema` and an entity that supplies a `config:` block (ADR-031 §4). The
Activity base reads `this.patternConfig` and computes the column keys itself. **No
template edit is required** — the change is the pattern record, the runtime base classes,
and tests. (The `as const` literal is structurally typed; the base declares
`patternConfig` as the inferred config type so `this.patternConfig.subject` is typed.)

## Config schema

```ts
const ActivityPatternConfigSchema = z
  .object({
    subject: z.string().optional(),        // subject entity name → FK column <subject>_id
    subjectColumn: z.string().optional(),  // explicit snake_case FK column override
    occurredAt: z.string().optional(),     // snake_case recency column; default occurred_at
  })
  .strict();
```

All optional: a date/user-only Activity entity supplies no `config:` block at all (and
then the templates emit no `patternConfig` property — the base falls back to
`occurred_at` for date range, and the subject finders throw if called). `.strict()`
rejects misspelled keys loudly, matching `JunctionPattern`.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/patterns/library/activity.pattern.ts` | edit | Add `configSchema`; replace `findByOpportunityId, findRecentByOpportunityId` in the inherited-method comment lists with `findBySubjectId, findRecentBySubjectId`; rewrite header (no more byte-compat claim); generic `description`. |
| `runtime/base-classes/activity-entity-repository.ts` | edit | Add `protected readonly patternConfig?` (typed via the schema's inferred shape); replace `findByOpportunityId`/`findRecentByOpportunityId` with config-driven `findBySubjectId`/`findRecentBySubjectId`; resolve the subject + occurredAt columns from `patternConfig` (camelCased); keep `findByDateRange` / `findByUserId`. |
| `runtime/base-classes/activity-entity-service.ts` | edit | Mirror: `IActivityEntityRepository` interface gains `findBySubjectId` / `findRecentBySubjectId` (drops the opportunity pair); service exposes `findBySubject` / `findRecent` delegating to the repo; keep `findByDateRange` / `findByUser`. |
| `test/scaffold/tests/activity-entity-repository.test.ts` | edit | Retarget the `findByOpportunityId` / `findRecentByOpportunityId` integration cases to `findBySubjectId` / `findRecentBySubjectId` with a `patternConfig = { subject: 'opportunity' }` on the test subclass (proves the same DB column via config). Add a case: a subclass with `subjectColumn` override; a case: calling a subject finder with no config throws. Keep gated behind `SCAFFOLD_INTEGRATION=1`. |
| `src/__tests__/patterns/activity-pattern.test.ts` | create | Registry-surface unit tests (mirror `junction-pattern.test.ts`): registered under `Activity`; advertises `findBySubjectId` / `findRecentBySubjectId` and **not** the opportunity finders; exposes a `configSchema`; schema accepts `{ subject: 'person' }`, accepts `{}`, rejects an unknown key. |
| `src/__tests__/clean-lite-ps/prompt-extension.test.ts` | edit | Update the PATTERN-5 expectations for `Activity` (inherited-method strings) so the byte-snapshot reflects the new finders. Add a `patterns: [Integrated, Activity]` case asserting composition resolves base to `IntegratedEntityRepository` and validates clean. |
| `src/__tests__/patterns/validate-composition.test.ts` | edit | Add a case: `patterns: [Integrated, Activity]` with `config: { Activity: { subject: 'person' } }` → no issues (valid composition; the whole point). Add: `config: { Activity: { subject: 42 } }` → `pattern_config_invalid`. |
| `CHANGELOG.md` | edit | 0.17.0 entry (Changed: Activity finders are config-driven; Breaking-for-nobody note re: census). |
| `package.json` | edit | `0.16.1` → `0.17.0`. |

## Test plan

- `bun test src/__tests__/patterns/` — pattern registry + composition (fast, no DB).
- `bun test src/__tests__/clean-lite-ps/prompt-extension.test.ts` — PATTERN-5 emission.
- The scaffold integration suite is gated behind `SCAFFOLD_INTEGRATION=1` (real Postgres)
  and is **not** in the default CI unit lane; the edits keep it compiling and correct for
  when it runs. Net-new behavior is covered by the unit + composition + registry tests
  above plus the base-class logic exercised through the retargeted integration cases.
- Pre-existing baseline (NOT in scope, do not fix): 7 schema-v2 failures
  (`contact-v2.yaml` integration + `cross-block validation`). Confirmed orthogonal.

## Consumer notes (post-merge)

- **swe-brain** (the originator): once published + bumped, an interaction entity can adopt
  `patterns: [Integrated, Activity]` with `config: { Activity: { subject: person } }`.
  Because `Integrated` wins the base (D4), the subject-scoped query is reached via the
  entity's `queries:` block (`queries: [{ by: [person_id] }]` → `findByPersonId`); the
  `Activity` config remains the declarative marker that the entity is a subject-scoped
  interaction (legible to the agent-aware query surface). If/when swe-brain wants the
  generic `findBySubjectId` inherited at runtime, it declares `pattern: Activity` (Activity
  primary) instead.
- **dealbrain-integrations**: unaffected — it never used the Activity pattern. No regen
  consequence.

## Out of scope

- Multi-base mixin so `[Integrated, Activity]` inherits *both* runtime bases (D4). Deferred
  until a consumer needs the generic finder inherited on an `Integrated`-primary entity.
- Multi-subject `findBySubjectId(subjectType, id)` overload (D1). The generic signature is
  chosen specifically so this lands additively when ADR-0006's multi-subject interactions
  arrive.
- Generating named per-subject finders (`findByPersonId`) into concrete repos from config
  — the `queries:` block already covers named finders.
