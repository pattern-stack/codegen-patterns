# #796: `type: datetime` and the behavior time columns emit `timestamptz`; `timezone: false` opts out

**Issue:** #796 (epic #793, Types and queries) · **Plan item:** `gaps-batch1` / `datetime-timestamptz` (Stack A, third,
the top of the stack) · **Gate 1:** strict (`gate:human`) · **Status:** implemented (Gate 1 approved 2026-11-03)
**Base:** `origin/main` @ `a8629dfc` · **Last updated:** 2026-11-03

## Overview

Every generated time column becomes `timestamp with time zone`. That covers each `type: datetime` field, the
`timestamps` and `soft_delete` columns, the junction template's five time columns, the relationship template's two,
and every `datetime` payload field on a junction or relationship. The subsystem tables already use
`withTimezone: true`, so after this change an app has one time convention. A field that really holds a wall-clock time
declares `timezone: false` and keeps a `timestamp without time zone` column. TypeScript types, DTOs and OpenAPI do not
change: the value is still a `Date`.

Every consumer's DDL changes. That is why this item has a human gate, and why the PR's "Changelog:" block (end of this
spec) carries the migration and its precondition.

## Decisions

Settled at Gate 0 (plan `open_questions`, approved with every recommendation):

- Junction and relationship time columns change in this PR: `created_at`, `updated_at`, the junction's `started_at`,
  `ended_at` and `matched_at`, and `datetime` payload fields. #771 is out of scope: `valid_from` / `valid_to` are
  `type: date`, which belongs to the date-mode decision in #776.
- Release level: minor, 0.32.0 (#818).

Made here, because the plan left them open:

1. **One rule, one module.** `src/schema/field-timestamp.ts` holds the rule, following the `field-nullability.ts`
   precedent (#736). It is dependency-free and the hygen prompts import it as `.js`. The schema and all three prompts
   read it, and so does the hand-written test locals harness. Nothing else spells the options literal.
2. **`timezone: false` works on junction and relationship payload fields as well as entity fields.** A field means the
   same thing on every kind of table. Junction and relationship `fields:` are not parsed by `FieldDefinitionSchema`
   (they are `z.any()`), so their prompts repeat the schema's refusal of `timezone:` on a non-`datetime` field, as the
   relationship prompt already does for `notNullWithoutDefault`.
3. **Opt-out shape:** `timezone: false` emits a bare `timestamp('<col>')`, as #796 says. A tz column emits
   `timestamp('<col>', { withTimezone: true, mode: 'date' })`. `mode: 'date'` is Drizzle's default for `timestamp`;
   it is written out so the TS type does not depend on that default.
4. **Correction to the plan's migration text.** drizzle-kit 1.0.0-rc.4 does not write `USING <col> AT TIME ZONE 'UTC'`.
   It writes `SET DATA TYPE timestamp with time zone USING "<col>"::timestamp with time zone` (its
   `ALTER COLUMN … SET DATA TYPE` builder appends `USING "<col>"::<new type>`). That cast reads stored values in the
   migrating session's `TimeZone`. The Changelog block says how to make the migration lossless.
5. **The integration test uses two different non-UTC zones.** The process runs at `TZ=America/New_York` (from the
   issue). The database session runs at `TimeZone=Asia/Kolkata` (+05:30, no DST). The two can never cancel out, and the
   size of a failure tells you its cause: a 4–5 h error is the process zone, a 5.5 h error is the session zone.
6. **The scaffold's information_schema check covers the whole `public` schema, with no carve-out.** To allow that, the
   scaffold's hand-written family test tables (`test/scaffold/schema.ts`) move to `timestamptz`. So do the semantic
   golden stand-in schema and its integration DDL. All of them mirror what codegen emits, and they must keep mirroring
   it.
7. **Delete `fieldTypeToDrizzle`** (`src/schema/entity-definition.schema.ts:1421-1433`). Nothing references it, and its
   `datetime: "timestamp"` row would become a second, wrong statement of the column rule.
8. **Leave `BaseJunctionFields`' `type: 'timestamp'` alone.** It names the Drizzle builder, which is still `timestamp`,
   and it feeds the collision check only (`src/patterns/registry.ts:86`). Codegen never emits it.
9. **The smoke assertion runs in three harnesses**: `run-smoke.ts`, `run-smoke-junction.ts` and
   `run-smoke-capability.ts`. The relationship template is compiled only by the capability smoke.

## As built (post-implementation)

Built as specified, with these differences and confirmations:

- **`package.json` `files`** gained `src/schema/field-timestamp.ts`. The spec's file table missed it; the two
  published-files-manifest gates (`template-src-imports`, `files-manifest-coverage`) fail without it, because the three
  prompts import the module.
- **`entity-definition.schema.json` was edited by hand.** `generate-json-schema.ts` calls Zod v4's `z.toJSONSchema`, and the
  repo is on Zod 3.25, so the generator cannot run (it already could not at #736). The `timezone` entry mirrors what
  the generator would write. Fixing the generator is out of scope.
- **The schema test goes through `EntityDefinitionSchema`.** `FieldDefinitionSchema` is not exported.
- **The migration statement was verified offline** (step 10) with `drizzle-kit generate` over a before/after schema. It
  writes `ALTER TABLE "<t>" ALTER COLUMN "<c>" SET DATA TYPE timestamp with time zone USING "<c>"::timestamp with time zone;`,
  exactly as the Changelog block says.
- **Baseline** changed in exactly the 3 predicted files (7 calls); the two junction snapshots changed in the 10 predicted
  calls plus the new `last_contacted_at` payload line.
- **Gate evidence at the base commit.** With the base templates and the scaffold fixture's `opens_at` line removed,
  `timestamptz.test.ts` fails T1 (every time column is without time zone), T2 (`created_at` read back 5 h 29 m late: the
  Kolkata wall clock stored from `DEFAULT now()` read as UTC), T3 (a plain `pg` reader off by exactly 5 h, the New York
  offset) and T4 (the DB-side count is 0). T5 passes on base, as predicted (R1). T6 fails there only because the
  opt-out field was removed to get the base to accept the fixture.
- **Local gate scope.** `just test-smoke` (default scenario), `test-smoke-junction` (vendored, default layout) and
  `test-smoke-capability` (vendored leg) pass with the scan. The capability smoke's package leg reports `tsc` errors in
  `account.composed-base.ts` and `roles.check.ts` (type-identity errors, none mentioning timestamps); the scan itself passed in that leg.
  The remaining legs run in CI.

## Emitted shapes

| Source | Before (`a8629dfc`) | After |
|---|---|---|
| `type: datetime` | `closedAt: timestamp('closed_at')` | `closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' })` |
| `type: datetime, required: true` | `timestamp('x').notNull()` | `timestamp('x', { withTimezone: true, mode: 'date' }).notNull()` |
| `type: datetime, default: now` | `timestamp('x').defaultNow()` | `timestamp('x', { withTimezone: true, mode: 'date' }).defaultNow()` |
| `type: datetime, timezone: false` | (schema error: unknown key) | `opensAt: timestamp('opens_at')` |
| `timestamps` | `timestamp('created_at').notNull().defaultNow()` (and `updated_at`) | `timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()` (and `updated_at`) |
| `soft_delete` | `timestamp('deleted_at')` | `timestamp('deleted_at', { withTimezone: true, mode: 'date' })` |
| junction `temporal` / `sourced` | `timestamp('started_at')`, `ended_at`, `matched_at` | each with `{ withTimezone: true, mode: 'date' }` |
| junction / relationship `created_at`, `updated_at` | `timestamp('created_at').notNull().defaultNow()` | `timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()` |
| junction / relationship `datetime` payload field | `timestamp('x')` | `timestamp('x', { withTimezone: true, mode: 'date' })`, or bare with `timezone: false` |
| `timezone:` on any non-`datetime` field | (unknown key) | error: `'timezone' can only be used with type 'datetime'…` |

What stays the same: the `timestamp` import (the builder name is unchanged), `$inferSelect` / `$inferInsert` (`Date`),
the Zod DTO chains (`z.coerce.date()`), OpenAPI, the `.defaultNow()` sentinel rendering (`renderColumnDefault` still
keys on `drizzleType === 'timestamp'`), and the runtime base classes. The base classes already write `new Date()`.

## Architecture

```
src/schema/field-timestamp.ts   (the rule: fieldWithTimezone, timezoneOnNonDatetime, timestampColumn, message)
   │
   ├── src/schema/entity-definition.schema.ts   BaseFieldSchema.timezone + refine (entity fields; Studio's
   │                                            schema-on-write and `entity validate` get it for free)
   ├── templates/entity/new/backend/entity-locals.js
   │      buildDrizzleChain: datetime branch → timestampColumn(name, fieldWithTimezone(field))
   │      buildBackendLocals → local `timestampColumn` ──→ entity.ejs.t  (created_at / updated_at / deleted_at)
   ├── templates/junction/new/prompt.js
   │      processCustomFields: refuse timezoneOnNonDatetime; `columnCall` for each field
   │      local `timestampColumn` ──→ junction/new/entity.ejs.t  (started/ended/matched/created/updated_at)
   └── templates/relationship/new/prompt.js
          processFields: refuse timezoneOnNonDatetime; buildDrizzleChain datetime branch
          local `timestampColumn` ──→ relationship/new/entity.ejs.t  (created_at / updated_at)
```

`DRIZZLE_TYPE_MAP.datetime` stays `'timestamp'` in all three prompts. It names the builder and the import. The options
belong to the column call, not to the type map.

## Files

| File | Action | Purpose |
|---|---|---|
| `src/schema/field-timestamp.ts` | create | The rule. Dependency-free, imported by the prompts as `src/schema/field-timestamp.js`. |
| `src/schema/entity-definition.schema.ts` | modify | `BaseFieldSchema` (L189-222): add `timezone: z.boolean().optional()`. `FieldDefinitionSchema` (L227): add a `.refine(!timezoneOnNonDatetime)` at path `['timezone']`. Delete `fieldTypeToDrizzle` and its doc comment (L1414-1433). |
| `src/schema/generate-json-schema.ts` | modify | Add `timezone` to the editor-autocomplete field schema, with a description. |
| `src/schema/entity-definition.schema.json` | regenerate | `bun src/schema/generate-json-schema.ts` (the #736 precedent). |
| `templates/entity/new/backend/entity-locals.js` | modify | `buildDrizzleChain` (L464): a `datetime` branch beside the `date` one. Update the L467-470 comment. Add a `timestampColumn` local to the `buildBackendLocals` return (beside `renderPatternConfigLiteral`, ~L2242). |
| `templates/entity/new/backend/entity.ejs.t` | modify | L60-64: the three behavior columns render through `<%- timestampColumn('…') %>`. |
| `templates/junction/new/prompt.js` | modify | `processCustomFields` (L116): refuse `timezone:` on a non-datetime field. Add a `columnCall` per field. Return `timestampColumn` as a local. |
| `templates/junction/new/entity.ejs.t` | modify | L61-62, L69, L86-87 go through `timestampColumn`. The custom-field generic branch (L80) renders `<%- field.columnCall %>`. Use `<%-`: the call contains quotes. |
| `templates/relationship/new/prompt.js` | modify | `buildDrizzleChain` (L171): `datetime` branch. `processFields` (L182): refuse `timezone:` on a non-datetime field (beside the `notNullWithoutDefault` throw). Return `timestampColumn` as a local. |
| `templates/relationship/new/entity.ejs.t` | modify | L91-92 go through `timestampColumn`. |
| `src/__tests__/schema/field-timestamp.test.ts` | create | Truth table for the rule, plus `EntityDefinitionSchema` accept/reject cases. |
| `src/__tests__/backend/entity-column-features.test.ts` | modify | New `describe('timestamptz columns (#796)')`. L105's expectation moves to the tz shape. |
| `src/__tests__/templates/timestamp-columns.test.ts` | create | Junction and relationship prompt → template rendering, using the harness in `relationship-field-nullability.test.ts` / `junction-endpoint-naming.test.ts`. |
| `src/__tests__/templates/junction-identity-pk.test.ts` | modify | Its hand-built locals gain `timestampColumn`, imported from the shared module, not re-implemented. |
| `test/smoke/_timestamp-columns.ts` | create | The smoke scan (see Interfaces). |
| `src/__tests__/smoke/timestamp-columns.test.ts` | create | Proves the scan fails on each bad shape (the `consumer-errors.test.ts` precedent). |
| `test/smoke/run-smoke.ts` | modify | Call the scan after `entity new` in both scenarios, against `FIXTURES_DIR` + `src/modules`. |
| `test/smoke/run-smoke-junction.ts` | modify | Call the scan on every leg, against `P.modules`. That is the layout's own modules dir, so the custom-layout legs check where the code under test actually writes (CLAUDE.md gate rule (b)). |
| `test/smoke/run-smoke-capability.ts` | modify | Call the scan after `relationship new --all`, so the relationship table is covered. |
| `test/smoke/fixtures/appointment.yaml` | create | `starts_at` (datetime, required), `reminded_at` (datetime, `default: now`), `opens_at` (datetime, `timezone: false`), behaviors `timestamps` + `soft_delete`. A new file, so it does not collide with #511/#784, which edit `tenant_note.yaml`. `run-smoke-subsystems.ts` reads the same directory, so the fixture is also compiled in package mode. |
| `test/smoke/fixtures-junction/junctions/opportunity_contact.yaml` | modify | Add the payload field `last_contacted_at: { type: datetime }`. |
| `test/smoke/fixtures/capability/relationships/crew_assignment.yaml` | modify | Add `fields: { assigned_at: { type: datetime } }`. |
| `test/scaffold/entities/appointment-scaffold.yaml` | create | `starts_at` (datetime, required), `opens_at` (datetime, `timezone: false`), `timestamps` + `soft_delete`. |
| `test/scaffold/schema.ts` | modify | `export * from '@gen/modules/appointments/appointment.entity'`. Every hand-written `timestamp('x')` in the family test tables (L60-215) becomes `{ withTimezone: true, mode: 'date' }`. |
| `test/scaffold/tests/timestamptz.test.ts` | create | T0–T6 below. |
| `test/semantic-golden/schema.ts` | modify | Its `timestamp(...)` columns (L61-105) take the tz shape. It mirrors the generated barrel. |
| `test/integration/semantic-fanout.drizzle.integration.test.ts` | modify | DDL (L164-186): `timestamp` → `timestamptz`. It mirrors `semantic-golden/schema.ts`. |
| `test/baseline/**` | regenerate | `just baseline`. Only `contacts/contact.entity.ts`, `deals/deal.entity.ts` and `opportunities/opportunity.entity.ts` change (7 calls). |
| `test/junction/__snapshots__/*.snap` | regenerate | `bun test --update-snapshots test/junction/`: 10 calls, plus the new payload field. |
| `consumer-skills/entities/yaml-reference.md` | modify | L61 type note: `datetime` is `timestamp with time zone`; `timezone: false` is wall-clock time, read through the `Date`'s UTC fields. L70 behaviors comment. One line on Electric: a `timezone: false` column arrives as a string unless `frontend.parsers.timestamp` is set. |
| `.ai-docs/stacks/gaps-batch1/datetime-timestamptz.md` | modify | This spec, brought to post-implementation truth (CLAUDE.md "living documentation"). |

Not changed, on purpose: `src/behaviors/*.ts` and `prompt.js`'s `behaviorRegistry` (`drizzleType: 'timestamp'` names the
builder; they feed the analyzer and DTOs, not the column), `runtime/**` (subsystem tables are already tz; base classes
write `Date`), `src/__tests__/runtime/base-classes/*.spec.ts` (they test the base classes, not emission), and the
frontend emitter (row types are consumer-owned `Date`).

## Interfaces

```ts
// src/schema/field-timestamp.ts. Dependency-free: the hygen prompts import it from the shipped src/ tree.

/** The two keys of a field declaration that decide its timestamp column. */
export interface FieldTimestampDeclaration {
	type?: string | null;
	timezone?: boolean | null;
}

/** A `datetime` column is timestamptz unless the field says `timezone: false`. */
export function fieldWithTimezone(field: FieldTimestampDeclaration): boolean;
//   → field.type === 'datetime' && field.timezone !== false

/** `timezone:` declared (true or false) on anything but `type: datetime`. Rejected everywhere. */
export function timezoneOnNonDatetime(field: FieldTimestampDeclaration): boolean;
//   → field.timezone !== undefined && field.timezone !== null && field.type !== 'datetime'

/** Shared by the schema refine and the junction / relationship prompt throws. */
export const TIMEZONE_ON_NON_DATETIME_MESSAGE: string;
//   "'timezone' can only be used with type 'datetime'. A datetime column is timestamp with time zone; " +
//   "'timezone: false' makes it a wall-clock timestamp without time zone."

/** The Drizzle builder call for a timestamp column. The only place the options literal is written. */
export function timestampColumn(column: string, withTimezone?: boolean /* default true */): string;
//   timestampColumn('created_at')        → "timestamp('created_at', { withTimezone: true, mode: 'date' })"
//   timestampColumn('opens_at', false)   → "timestamp('opens_at')"
```

```ts
// src/schema/entity-definition.schema.ts (additions only)
BaseFieldSchema: { …, timezone: z.boolean().optional() }
FieldDefinitionSchema: .refine((d) => !timezoneOnNonDatetime(d),
                                { message: TIMEZONE_ON_NON_DATETIME_MESSAGE, path: ['timezone'] })
```

```ts
// test/smoke/_timestamp-columns.ts

/** `<table>.<column>` for every `timezone: false` field in the fixture YAMLs (charter I1: from the YAML, not from the
 *  emitted file). The table is `entity.table ?? entity.plural`, or `relationship.table`. Throws on an opt-out whose
 *  table it cannot name, such as one in a junction YAML; it never guesses (CLAUDE.md gate rule (c)). */
export function collectTimezoneOptOuts(yamlFiles: string[]): Set<string>;

/** Scans every `*.entity.ts` under `modulesDir`. Each `timestamp(` call must be exactly
 *  `timestamp('<col>', { withTimezone: true, mode: 'date' })`, or exactly `timestamp('<col>')` when
 *  `<pgTable name>.<col>` is in `optOuts`. Throws, naming file, table and column, when:
 *    - a call has any other shape (bare, `{ mode: 'date' }` alone, extra options, double quotes, …);
 *    - a `timestamp(` occurrence does not parse as a call (fail closed);
 *    - no entity file, or no timestamp call at all, was found (the scan cannot pass vacuously);
 *    - a declared opt-out was never seen, or was emitted with tz (the opt-out itself is checked). */
export function assertTimestampColumns(modulesDir: string, optOuts: Set<string>): { files: number; calls: number };
```

## Implementation steps

1. **The rule** (`src/schema/field-timestamp.ts` + `field-timestamp.test.ts`). Write the tests first; on the base
   commit they fail on import.
2. **Schema** (`entity-definition.schema.ts`, `generate-json-schema.ts`, regenerated JSON). Delete `fieldTypeToDrizzle`.
3. **Entity pipeline** (`entity-locals.js`, `entity.ejs.t`). In `buildDrizzleChain`, add
   `else if (field.type === 'datetime') chain = timestampColumn(fieldName, fieldWithTimezone(field))`. Run the
   `.array()` / `.notNull()` / default suffixes after it as today. Update `entity-column-features.test.ts`.
   `strict-locals.test.ts` must stay green with the new local.
4. **Junction pipeline** (`junction/new/prompt.js`, `entity.ejs.t`). Error text:
   `[codegen] junction field '<name>': <TIMEZONE_ON_NON_DATETIME_MESSAGE>`. Update `junction-identity-pk.test.ts`'s
   locals.
5. **Relationship pipeline** (`relationship/new/prompt.js`, `entity.ejs.t`). Error text:
   `[codegen] relationship field '<name>': …`.
6. **Template tests** (`src/__tests__/templates/timestamp-columns.test.ts`).
7. **Smoke scan** (`test/smoke/_timestamp-columns.ts` + its unit test). Wire it into the three harnesses and add the
   fixtures.
8. **Scaffold** (fixture, `schema.ts`, `timestamptz.test.ts`). Move the hand-written mirrors (scaffold family tables,
   semantic golden, semantic-fanout DDL) to tz.
9. **Regenerate** baseline and junction snapshots. Review the diff: it must contain only the tz options, the new
   junction payload field and its DTO/type lines.
10. **Docs** (`yaml-reference.md`). Bring this spec to post-implementation truth. Verify the migration SQL quoted in the
    Changelog block with an offline `drizzle-kit generate` over a before/after schema (no database needed). Paste the
    real statement for one column into the PR's block.

## Tests and gates

### Every gate fails on its own subject at `a8629dfc`

| Gate | Subject | How it fails on the base commit | Evidence gathered at spec time |
|---|---|---|---|
| `just test-unit`: `field-timestamp.test.ts` | the rule and the schema key | The module does not exist. `timezone: false` is an unknown key under `.strict()`. | `FieldDefinitionSchema` is `.strict()` (L233). |
| `just test-unit`: `entity-column-features.test.ts` #796 block | entity emission | Base emits `timestamp('closed_at')` and `timestamp('created_at').notNull().defaultNow()`. | `buildDrizzleChain` has no datetime branch (L472-480). `entity.ejs.t` L60-64 are bare. |
| `just test-unit`: `templates/timestamp-columns.test.ts` | junction and relationship emission | Base emits bare calls for every time column and payload field. | Junction `entity.ejs.t` L61-62/69/86-87 and relationship L91-92 are bare. |
| `just test-unit`: `smoke/timestamp-columns.test.ts` | the scan itself | Each synthetic bad input (bare, `{ mode: 'date' }` only, unparseable, zero files, missing opt-out, opt-out emitted with tz) must make `assertTimestampColumns` throw. A scan that always passes fails this test. | n/a (new helper) |
| `just test-baseline` | committed entity golden | The regenerated snapshots carry the tz options. Base output has 7 bare calls in 3 files, so the byte compare fails. | `grep -rnoE "timestamp\('[a-z_]+'\)"` over `test/baseline/packages` finds 7 at base. |
| `just test-junction` | committed junction golden | The same: base output has 10 bare calls across the two snapshots. | The same grep over `test/junction/__snapshots__` finds 10. |
| `just test-smoke` (both scenarios), `test-smoke-junction` (4 legs + cross-domain), `test-smoke-capability` | what a consumer actually gets | Run the new scan on base output, with the fixtures' `timezone: false` lines removed, because base rejects the key. It throws on the first `timestamp('created_at')`. With the lines kept, base fails earlier, at `entity new`, on the unknown key. That failure is real, but it is not the subject, so the PR records the scan's own failure. | Base output is bare (above). |
| `just test-integration`: T1–T4 | the database: DDL, DB defaults, other readers | Run on base, with the scaffold fixture's `opens_at` line removed, each fails as described under "Integration test" below. Record the output in the PR. | The drizzle-orm rc.4 codecs and pg parsing were checked at spec time (Risks, R1). |
| `just test-semantic-integration` (CI integration job) | the semantic engine over the new column type | It does not need to fail: it is a regression guard that must stay green with the tz DDL. | — |

`test-smoke-subsystems` compiles the new smoke fixture in package mode too. It is a compile gate for the fixture, not a
gate on this subject.

### Integration test: `test/scaffold/tests/timestamptz.test.ts`

Gated by `_skip-guard.ts` like every scaffold suite. Its fixture is the `appointment` scaffold entity.

- **Setup.** In `beforeAll`, save the current `process.env.TZ` and set `America/New_York`. Bun applies a runtime `TZ`
  change; this was checked at spec time. Open two pools:
  - `nonUtc`: `new Pool({ connectionString, options: '-c TimeZone=Asia/Kolkata' })`, wrapped as
    `drizzle({ client, relations })`, with the generated `AppointmentRepository` built over it;
  - `raw`: a plain `pg` `Pool` with node-postgres' default type parsers. Drizzle passes its own parsers per query
    (`node-postgres/session.js` `typeConfig`), so this pool reads as any other node-postgres client would.

  In `afterAll`, end both pools and restore `TZ`. If it was unset, restore `Etc/UTC`, which is what `bun test` runs
  under. Every scaffold file runs in one process.
- **T0 (preconditions).** `new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset() !== 0`, and `SHOW TimeZone` on
  `nonUtc` returns `Asia/Kolkata`. Without these, T2–T4 could pass under UTC by accident.
- **T1 (DDL).** `information_schema.columns` in schema `public` where `data_type = 'timestamp without time zone'`
  returns exactly one row: `appointments.opens_at`. As a positive check, `appointments.{starts_at, created_at,
  updated_at, deleted_at}` and `opportunity_contacts.created_at` are `timestamp with time zone`, so the check cannot pass
  because the tables are missing. *Base:* every generated time column is without time zone.
- **T2 (DB default under a non-UTC session).** Insert through `nonUtc` with `db.insert(appointments)` and no
  `createdAt`, so the column takes `DEFAULT now()`. Read the row back through `nonUtc`. `createdAt` must fall within
  [t_before − 60 s, t_after + 60 s]. *Base:* `now()` is stored as the Kolkata wall clock, and Drizzle reads naive
  values as `+0000`, so the value is 5 h 30 m late.
- **T3 (another reader in a non-UTC process).** Create through the generated repository; the base class writes
  `new Date()`. Read `created_at` through `raw`. It must equal the repository's returned `createdAt` to the
  millisecond. *Base:* pg-types reads a naive value as process-local time, so it is off by the New York offset.
- **T4 (a DB-side reader under a non-UTC session).** Create through the repository, then run
  `select count(*) … where id = $1 and created_at <= now() and created_at > now() - interval '1 minute'` on `nonUtc`.
  The count must be 1. *Base:* the stored UTC wall clock is read as Kolkata time, which puts it 5 h 30 m in the past,
  so the count is 0.
- **T5 (the issue's literal Done-when).** With the process at New York time, write
  `startsAt = new Date('2026-03-08T06:30:00.000Z')` through the repository and read it back through `findById`. The
  instant is the same. *This also passes on base.* Drizzle sends `toISOString()`, and on read it parses a naive value as
  `+0000`, so a JS round trip is time-zone-proof either way (R1). T5 guards the JS path; it is not evidence for the fix.
- **T6 (the opt-out is wall-clock time).** Write `opensAt = new Date(Date.UTC(2026, 0, 1, 9, 0))`. On `nonUtc`,
  `select opens_at::text` returns `2026-01-01 09:00:00`, unaffected by the session zone, and `findById` returns the same
  `Date`. This is the opt-out's own proof, not a base-red case.

## Risks checked at spec time

- **R1: a JS round trip cannot fail on base** (the plan's gate warning, confirmed). In drizzle-orm 1.0.0-rc.4
  (`pg-core/columns/timestamp.js`, `pg-core/codecs.js`, `node-postgres/codecs.js`), a timestamp write is
  `value.toISOString()`. Postgres drops the offset when the target is `timestamp without time zone`. On read, the
  `timestamp` codec is `new Date(v + '+0000')` and the `timestamptz` codec is `new Date(v)`. The Drizzle node-postgres
  session hands timestamp text through unparsed. So the failure the host application hits comes from `DEFAULT now()`
  under a non-UTC session (T2) and from readers other than Drizzle (T3, T4). Checked locally:
  - `postgres-date` under `TZ=America/New_York` parses `'2026-01-01 12:00:00'` as `17:00Z`;
  - Bun 1.3 and Node both parse Postgres' tz text (`'… 07:00:00.123-05'`, `'… +05:30'`) to the right instant;
  - Bun applies `process.env.TZ` changes at runtime.
- **R2: semantic time grains.** `@pattern-stack/query-surface` 0.3.1 renders no time grain, and neither does codegen:
  there is no `date_trunc` in either source. Grains are query-time (`yaml-reference.md`), so nothing changes today.
  Whoever adds grains must pin the zone, because `date_trunc` on a `timestamptz` follows the session `TimeZone`. Pin it
  with `date_trunc(unit, col, 'UTC')` (PG 14+) or `AT TIME ZONE`. `test-semantic-integration` stays green with the tz
  DDL.
- **R3: the frontend's Electric parsers.** The default `frontend.parsers` is
  `{ timestamptz: '(date: string) => new Date(date)' }` (`codegen-config.schema.ts:351-353`). Before this change it
  matched no generated column, so Electric-synced rows carried strings in fields typed `Date`. After it, every generated
  time column parses to `Date`. This is a behaviour change, and a fix. It is stated in the Changelog block. No code
  change.
- **R4: migration SQL.** See Decision 4 and the Changelog block. A `timestamp → timestamptz` type change normally
  rewrites the table. With the session at UTC, Postgres 12+ skips that rewrite (PG 12 release notes); the
  `AT TIME ZONE` form may not. The implementer confirms the drizzle-kit statement offline (step 10).
- **R5: restack (Stack A).** This PR lands on #784, and both touch `entity-locals.js` (different functions),
  `BaseFieldSchema`, `entity.ejs.t` and `yaml-reference.md`. Resolve snapshot conflicts by regenerating, never by
  hand-merging. T1 covers the whole `public` schema: if #511 or #784 add a hand-written scaffold table with a bare
  `timestamp`, T1 fails on the restacked branch. That is intended; give the table the tz shape.

## Charter invariants touched (relations-v2 PROJECT.md §4)

- **I1:** the rule lives in one module, and every column call is derived from the YAML field. The smoke's opt-out set
  is read from the fixture YAML, not from the emitted file.
- **I7:** there is no global switch back to naive time and no compat flag. `timezone: false` is a per-field meaning
  (wall-clock time), not a way to avoid the migration. The Changelog block says so.
- **I9:** every gate above fails on its subject at base, except T5 and T6, which are labelled for what they are. The
  information_schema check has no carve-out. The smoke scan fails closed.
- **I10:** the fixtures use a generic `appointment` entity.

## Out of scope; found on the way

- #771 / #776: `valid_from` / `valid_to` and `type: date` modes.
- An entity's `temporal_validity` behavior emits no columns at all today. `prompt.js`'s `behaviorRegistry` declares
  `valid_from` / `valid_to` as datetime, but `entity.ejs.t` and `repository.ejs.t` never read the flag. So there is
  nothing to convert here. If it ever emits columns, they go through `timestampColumn`.
- A string `default:` on a `datetime` field renders `.default('<string>')` against a `Date`-mode column. This is
  pre-existing and unrelated to time zones.

## Changelog block (verbatim, for the PR body)

```markdown
Changelog:

### Changed (BREAKING, DDL): every generated time column is `timestamp with time zone` (#796)

- `type: datetime` fields, the `timestamps` columns (`created_at`, `updated_at`) and the `soft_delete` column
  (`deleted_at`) now emit `timestamp('<col>', { withTimezone: true, mode: 'date' })`. The same applies to the junction
  template's `started_at`, `ended_at`, `matched_at`, `created_at` and `updated_at`, to the relationship template's
  `created_at` and `updated_at`, and to every `datetime` field on a junction or relationship. Subsystem tables already
  used `timestamptz`, so an app now has one convention.
- New field key `timezone: false` (on `type: datetime` only) keeps a wall-clock column as
  `timestamp without time zone`. Its value reads back as a `Date` whose UTC fields are the wall-clock time.
  `timezone:` on any other type is a validation error. Use it for values that are genuinely wall-clock times, not to
  skip the migration.
- TypeScript types, DTOs and OpenAPI are unchanged (`Date`).
- Frontend with Electric sync: the default `frontend.parsers.timestamptz` now matches every generated time column, so
  synced rows carry `Date` values. Before, they carried strings. A `timezone: false` column still arrives as a string
  unless you add a `timestamp` parser.

#### Upgrading

1. Mark any column that holds a wall-clock time with `timezone: false`. Then regenerate:
   `entity new --all --force`, `junction new --all --force`, `relationship new --all --force`.
2. Generate the migration. For each column, drizzle-kit (1.0.0-rc.4) writes:
   `ALTER TABLE "<table>" ALTER COLUMN "<col>" SET DATA TYPE timestamp with time zone USING "<col>"::timestamp with time zone;`
   That cast reads each stored value in the migrating session's `TimeZone`. Put `SET TIME ZONE 'UTC';` at the top of
   the migration, or rewrite the clause as `USING "<col>" AT TIME ZONE 'UTC'`. With the session at UTC, Postgres 12+
   also skips the table rewrite for this cast.
3. Either way, the conversion is lossless only if the stored values are UTC. Values written through the generated
   repositories are UTC, because Drizzle sends UTC whatever the process `TZ`. Values filled by `DEFAULT now()`, or
   written by other SQL, are in the writing session's `TimeZone`. If any session ran outside UTC, correct those rows
   before you migrate.
```

## References

- Issue #796; plan `gaps-batch1` (`origin/dugshub/gaps-batch1-plan:.ai-docs/stacks/gaps-batch1/plan.yaml`), item
  `datetime-timestamptz`, `changelog_policy`, `open_questions.junction_temporal`.
- Shared-rule precedent: `src/schema/field-nullability.ts` (#736 / #613).
- Subsystem convention: `runtime/subsystems/events/domain-events.schema.ts:60`.
- Gate rules: CLAUDE.md "A gate must be able to fail on its own subject"; smoke location scoping:
  `test/smoke/_consumer-errors.ts`.
