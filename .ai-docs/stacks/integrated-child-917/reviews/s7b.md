# Review — S7b (`dugshub/917-s7b-integrated-repository`, `6ec08b26..8a3135d6`)

**Verdict: `ACCEPT_WITH_FIXES`** — 0 blocker · 4 should-fix · 8 nit · 1 `DECISION` (finding 2), plus one follow-up
`DECISION` outside S7b (in finding 1).

The repository half is right. The child table has no identity columns. The base emits one constraint. The persist hook
leaves the default path unchanged. The forwarded reads and the tombstone are kind-scoped, and a test fails when that
scoping is removed. What needs fixing is the fixture's `exclude_fields: [title]`: no sync of that fixture can write a
row, and the Docker test hides this by widening the write columns. The RFC also misstates what a sync emits.

## How this was checked

- **Gates, run on the branch head:**
  - `bun run typecheck`: exit 0.
  - `just test-unit`: 5080 pass, 1 fail. The failure was `api-surface-project-golden`, caused by my own leftover
    repo-root `junctions/` from a `--no-teardown` scaffold run. Rerun on a clean tree: 16/16.
  - `bun test/scaffold/run-integration.ts` (Docker): 334 pass, 0 fail.
  - `just test-baseline`: passes (`✅ All tests passed!`, exit 0).
- **Probes** against the scaffold Postgres, using the **generated** config (no widening), in a throwaway test file. Since
  deleted.
- **Mutations**, each restored byte-for-byte afterwards (`git status` is clean):
  - M1: the default hook's no-clobber guard;
  - M2: the default hook's tenant-`set` guard;
  - M3: the default hook's return value;
  - M4: the generated child tombstone made kind-blind;
  - M5: `INTEGRATION_METHOD.findManyByExternalIds` renamed.

## The builder's four flags

| Flag | Verdict |
|---|---|
| (a) The sink writes through the repository, so no events | **True** for service lifecycle events, for every entity. **Incomplete** as written: `emit_changes` still publishes. → finding 2, `DECISION`. |
| (b) `exclude_fields: [title]` on a required base field | **Yes, it hides a defect.** No sync of the fixture can create *or update* a row. The test widens the config and asserts the opposite of `exclude_fields`. → finding 1. |
| (c) The mailbox FK resolver looks for `provider` / `external_id` | **True, and it predates S7b: #779.** Every plain Integrated entity with a belongs_to onto a non-Integrated parent has it. The child behaves as a plain entity would. → finding 5. |
| (d) `writeIntegrationRow` split; NULL guard; kind-scoped join | **Unchanged / correct.** The default path is statement-for-statement the old code, and its guards are test-covered (M1, M2 red). The NULL guard refuses no write that used to succeed, except the edge case in finding 7. The kind scoping holds by construction and is test-covered (M4 red). |

---

## Findings

### 1. should-fix · Quality — the fixture's sink can never write; the Docker test widens the config to hide it

`test/fixtures/integrated-child/entities/mail_message.yaml:27`, `calendar_event.yaml:26` (`exclude_fields: [title]`);
`test/scaffold/tests/integrated-child.test.ts:60-69` (`withTitle`); `src/__tests__/backend/490-sink-knobs-contract.test.ts:439`.

- `title` is `required: true` on `inbox_item`. The generated `integrationConfig.writeColumns` is `['subject', 'sentAt']`.
- **Verified on Postgres, generated config:**
  - `integrationUpsertOne({ externalId, subject, sentAt }, 'google')` fails with `23502 null value in column "title" of
    relation "inbox_items"`.
  - **An update of an existing pair fails the same way.** Postgres checks NOT NULL on the proposed row before ON
    CONFLICT arbitration, and the base upsert's `VALUES` carries no `title`.
  - So a real sync of this fixture fails every item, create and update alike.
- `withTitle` adds `title` back to `writeColumns`, so the Docker test runs a config the sink never has. The test's
  header says "Every call is the one the generated sink makes on a plain entity", which is not true with the widening.
- The test then asserts `title` becomes `'edited'` through a sync update. That is the opposite of `exclude_fields`' own
  contract: an excluded field is never written by the sync.
- So the no-clobber half of `exclude_fields` through the pair is untested. It is also unreachable on this fixture.
- This breaks CLAUDE.md's gate rule (b): assertions must resolve through the same configuration as the code under test.
- **S7b's pair write is not at fault.** It omits `title` correctly.
- **The gap predates S7b.** `excludeFieldIssues` (`src/schema/entity-definition.schema.ts:964`) accepts a NOT NULL column
  with no default. Verified on a plain entity: `org_lead` with `name` dropped from `writeColumns` fails `23502` the same
  way.

**Fix (S7b):**
- Exclude a *nullable* base field instead: add one to `inbox_item` (for example `preview: { type: string, nullable: true }`),
  or make `title` optional.
- Delete `withTitle`, so the Docker test runs the generated config.
- Add the missing assertion: a sync update that carries the excluded field leaves the base row's value alone.
- Update the 490 (e) test and the RFC's "widens the write columns" sentence (`RFC-0006:2059`).
- The fixture lives in three places (integrated-child source, baseline, scaffold), and S7c's goldens read it, so the
  change cascades up the stack.

**Follow-up `DECISION` (not S7b; it changes which YAML validates):** should `exclude_fields` refuse a NOT NULL column with
no `default:`, for every entity? Such a config cannot write a single row.
- Options:
  - (A) refuse, naming the column and why;
  - (B) keep accepting it.
- Recommendation: **(A)**.

### 2. should-fix · Adherence + `DECISION` — what a child's sync emits; the RFC sentence is wrong as written

`docs/rfcs/RFC-0006-joined-table-inheritance.md:2054-2056`; brief item 6.

What a plain Integrated entity's sync emits today (verified by reading):

- **Service lifecycle events.** The generated sink calls the repository:
  - `this.repo.integrationUpsertOne` (`src/cli/shared/sink-emission-generator.ts:425`);
  - `findByExternalIdProjected` (`:410`);
  - `softDeleteByExternalId` (`:311`).

  It never calls the service, so no sync emits `<entity>.created` / `.updated` on `EVENT_BUS`. That holds for every
  entity, plain or child.
- **`emit_changes: true`.** `ExecuteIntegrationUseCase` publishes `<entity>_created` / `_edited` / `_deleted` through
  `INTEGRATION_CHANGE_EMITTER` on `TYPED_EVENT_BUS`:
  - `runtime/subsystems/integration/execute-integration.use-case.ts:341-365` (create/update);
  - `:283-285` (delete).
  - The action comes from `existing === null`, read through the sink's `findByExternalIdProjected`.
- **What that gives a child, today.** The fixture children set `emit_changes: true`, so a child's sync publishes
  `mail_message_created` / `_edited` / `_deleted` under **its own name only**.
  - The baseline registry gains exactly those six events (`runtime/subsystems/events/generated/registry.ts`).
  - Nothing publishes an `inbox_item_*` event.
  - The edge cases come out consistent:
    - an orphan repair reads `existing === null`, so `created`, which matches the child row being inserted;
    - a `KindMismatchError` fails the item and emits nothing.

So the RFC's "a sink write emits no `created` / `updated` event for ANY entity" leaves out the `emit_changes` path. Brief
item 6 ("a write emits under both names … check that the sink-facing path goes through it") is unmet. Meeting it changes
generated behaviour, so it is a `DECISION`.

- **(A) Keep it as built** — *recommended.*
  - A child's sync emits exactly what a plain entity's emits: the `emit_changes` triad under the child's name, and no
    lifecycle event.
  - Fix the RFC sentence and record that item 6 was dropped.
  - No generated change.
  - This is S7's own rule: "a provider sync has no opinion on an entity's family hierarchy." The sink cannot tell a
    child from a plain entity.
- **(B) Also publish a base-named triad** (`inbox_item_created` / `_edited` / `_deleted`) when a child opts in.
  - Needs base-named event definitions synthesized from a child's opt-in.
  - Needs `baseCreated` carried from `integrationUpsertOne` through the sink to the orchestrator. Today only `{ id }`
    comes back, and `existing === null` is the wrong signal for the base in the orphan case.
  - Touches the S7c sink and the runtime orchestrator, and makes the sync family-aware.
- **(C) Route the sink through the service.**
  - Every Integrated sync, plain ones included, starts emitting lifecycle and per-field events, and a child emits them
    under both names (A11).
  - It would emit next to `emit_changes`, so an entity with both gets two events per write.
  - This is a project-wide decision, not S7's.

**Recommendation: (A).** If Doug wants base-level visibility of synced rows, make it a separate issue covering all
entities (C, or a reshaped `emit_changes`), not a family special case.

### 3. should-fix · Quality (ADR-046) — the template picks bodies by literal method name, and the persist hook rides on one

`templates/entity/new/backend/repository.ejs.t:905, 929, 935, 942`.

- The `integration_through_base` branch chooses each body with `m.name === 'findByExternalId'` (and so on). These are
  the only `m.name === '…'` comparisons in the backend templates; every other method shape gets its own `kind`.
- The private `rowsThroughBase` helper prints inside the `findByExternalId` branch.
- The protected `writeIntegrationRow` override prints inside the `softDeleteByExternalId` branch.
- M5 (renaming `findManyByExternalIds` in `names.ts`) turned parity and the render test red, so a rename is caught.
- What is **not** caught: the hook is protected, so it is not in the surface and parity does not list it.
  - If the derivation ever stopped listing `softDeleteByExternalId` for a child, the override would silently disappear.
  - The child would then fall back to the default hook, which inserts `externalId` / `provider` into a table that has
    neither.
- **Fix:** give the derivation a discriminating property per entry (or four kinds), and decide the hook's existence
  once, from a flag of the surface or one local.
- There is already an unused local for that, `integrationThroughBase`; see finding 8.

### 4. should-fix · Quality — "is this entry the identity pair" has two owners

`templates/entity/new/backend/entity-locals.js:1102-1108` (`adoptedExternalIdKeyIndex`).

- It re-implements `isIntegratedNaturalKey` (`src/schema/inheritance.ts:55`): sort and compare against
  `INTEGRATED_NATURAL_KEY`.
- `isIntegratedNaturalKey` is exported and already read by R11 and `validate-inheritance.ts:147`.
- If the two ever disagree (an order-sensitivity change, a third identity column), validation accepts a key that
  emission does not adopt, or the reverse.
- **Fix:** `return isIntegratedNaturalKey(definition.unique_indexes[i].fields) ? i : -1`.

### 5. nit · Adherence — the base belongs_to's FK resolver is #779; name it

`test/baseline/.../mail-message.repository.ts:173` (`{ column: 'mailboxId', writeKey: 'mailboxExternalId', refTable: mailboxes }`).

- **Verified on Postgres:**
  - supplying `mailboxExternalId` throws `MailMessageRepository.integrationConfig.fkResolvers['mailboxId']: table has no
    column 'provider'`;
  - leaving it out resolves to `null` and the row is written.
- Plain entities already have the same resolver shape: `contact` → `users` / `accounts` and `deal` → `users` / `accounts`
  (`contact.repository.ts:131-132`, `deal.repository.ts:131-133`). Open issue #779 covers it.
- S7b is right not to special-case the child.
- Fixing it changes `<Entity>IntegrationWrite` for every Integrated entity (an FK onto a non-Integrated parent becomes a
  plain write column), so it is #779's.
- **Ask:** the RFC's S7b note should name #779, so S7c and S7d do not treat `mailboxExternalId` as a working path.

### 6. nit · Quality — the child's soft tombstone does not bump `updated_at`; a plain entity's does

`templates/entity/new/backend/repository.ejs.t:954`.

- The plain tombstone sets `{ deletedAt, updatedAt }` (`runtime/base-classes/integrated-entity-repository.ts:217`).
- The child calls `baseRepo.delete`, which sets only `deleted_at`.
- Probe: `updated_at` was unchanged after `calendar_event`'s soft tombstone.
- The projection carries `updatedAt`, so this is a small break of "the sink cannot tell a child from a plain entity".
- The tombstone (null-out) mode does bump it, through `baseRepo.update`.

### 7. nit · Quality — the NULL guard also refuses an absent natural-key column that has a `default:`

`templates/entity/new/backend/repository.ejs.t:1005`.

- On `catalog_entry` (`sku`) and `communication` (`source, external_id`) every key column is `required: true` with no
  default.
- There the guard only turns a Postgres `23502` into `NaturalKeyNullError`, before any statement. No write that used to
  succeed is refused, and the Docker suite is green.
- But R11 accepts a `required: true` column that has a `default:`. Before, an absent value took the default and the
  upsert worked; now it is refused.
- Only the two nullable identity columns need the guard.
- **Options:**
  - skip key columns that have a column default;
  - or say in the RFC that a natural key is always caller-supplied.
- Verified by reading, not run.

### 8. nit · Quality — dead local `integrationThroughBase`

`templates/entity/new/backend/entity-locals.js:2957`.

- Computed, never read: the template recomputes `_integrationThroughBase` from the methods.
- Either use it (finding 3) or delete it.

### 9. nit · Quality — the identity constraint's name is spelled twice

`templates/entity/new/backend/entity-locals.js:2271` (adopted) and `:2342` (the behaviour's own).

- Both are `` `uq_${table}${tenant ? '_tenant' : ''}_${INTEGRATED_NATURAL_KEY.join('_')}` ``.
- One keys on `tenancy`, the other on `tenantScoped`.
- Make it one helper.

### 10. nit · Adherence — the child's "Inherited from" comment lists the four methods it now overrides

`test/baseline/.../mail-message.repository.ts:516-519`.

- The comment prints the pattern's lines (#893's named expectation, `inherited-comment-expectation.test.ts`).
- Record the new false lines against #893 rather than fixing them here.

### 11. nit · Quality — the drift test omits `mailbox`

`src/__tests__/derived/integrated-child-render.test.ts` ("the integrated-child fixture copies agree").

- It checks `inbox_item`, `mail_message` and `calendar_event`, but not `mailbox`, which is copied to the baseline and the
  scaffold too.
- The copies are equal today (checked).

### 12. nit · Quality — the inherited batch `integrationUpsert` is not usable on a child

`runtime/base-classes/integrated-entity-repository.ts:240`.

- Its input is `Partial<TEntity>`, and the child's `TEntity` (its own table row) has no `externalId` / `provider`, so a
  typed call cannot pass the keys the method skips rows without.
- It returns child-table rows, not flat rows.
- Nothing in the repo calls it.
- Either refuse it on a child, or note it as out of S7. Verified by reading.

---

## Outside S7b, verified, for the coordinator to file

- **O1 — a plain tenant-scoped Integrated entity in tombstone mode fails its second tombstone in a tenant.**
  - The behaviour's unique is `NULLS NOT DISTINCT` on `(tenant, provider, external_id)`, so two detached rows
    `(T, NULL, NULL)` collide.
  - Probe on `org_lead` (`softDelete: false`): the first `softDeleteByExternalId` returns `{ id }`; the second fails
    `23505 uq_org_leads_tenant_provider_external_id`.
  - The family base avoids it, because the adopted key keeps NULLs distinct.
  - No open issue matches.
- **O2 — `api-surface-project-golden` reads repo-root `junctions/`.**
  - A `run-integration.ts --no-teardown` run leaves that directory behind, and `just test-unit` then goes red
    (`mail_message.inherits` vs `junction opportunity_contact`).
  - This is fragile harness state, not S7b's doing.

## What S7c / S7d inherit

- **S7c:** the decision in finding 2.
- **S7c and S7d:**
  - the fixture change in finding 1, which re-blesses S7c's goldens;
  - #779 for any test that passes `mailboxExternalId`.
- **S7d's Docker test** should run the generated config with no widening.

## Gate tails

```
typecheck exit 0
just test-unit: 5080 pass, 3 skip, 1 fail (project golden; my repo-root junctions/ leftover) → clean tree: 16 pass, 0 fail
run-integration (Docker): 334 pass, 2 skip, 0 fail
just test-baseline: ✅ All tests passed! (exit 0)
```
