## Gate 2.5 — Adherence (lens=adherence) · PR #910 @ edc04676

**Against:** RFC-0006 §12 (A6, A7, A11, A5's insert-fill clause) + §13.2 S4 (plan, "as built", phase R, phase R2)
**Verdict:** PASS_WITH_NOTES

Reviewed `git diff dugshub/875-s3-inherits-reads...HEAD` in the worktree. The local tip, `7a11b49d`, is patch-identical
to the PR tip, `edc04676`: `git range-diff` shows `=` for both S4 commits, and the remote stack has only been rebased onto
a newer `main`. Line numbers below are at that tip. Every claimed acceptance item is met and has a test. The findings
are one behaviour gap in the A11 event path, a gate claim that does not cover its subject, and places where the RFC no
longer says what the code does.

### Blockers

None.

### Should-fix

1. `runtime/base-classes/base-service.ts:229-237` together with `templates/entity/new/backend/repository.ejs.t:796-810`.
   A child service's `delete` emits `<base>.deleted` for a live row of another kind. The pair delete is deliberately a
   no-op when the id is not a child in scope (`if (own[0] === undefined) return;`, `:808`). The child service has no
   `delete` of its own (the derivation pushes only `pair_create` / `pair_update` to the service), so it inherits
   `BaseService.delete`, which emits `meeting.deleted` **and** `communication.deleted` whether or not anything was deleted.
   **Scenario:** `meetingService.delete(email.id)` leaves the email's base row and child row untouched, as the as-built
   note promises, but publishes `communication.deleted` with that email's id. A subscriber to every communication (a
   search projection, a cache) then drops a row that still exists. The pre-existing "deleted for a missing id" behaviour
   was harmless because there was no row. Here the base row is live. Today only hand-written callers reach this; S5's
   `DELETE /meetings/:id` makes it reachable over HTTP. No test covers it: the repository test
   (`inheritance-writes.test.ts:189`, "update and delete through a child never touch a row of another kind") asserts
   rows, not events.
   **Fix:** derive a service `pair_delete` entry (delegating to the repository's, origin `inherits:`). Its body emits
   both names only when the row was a child in scope, either from a pre-read (the class already pre-reads for `update`)
   or from a flag the repository's pair delete returns through a protected hook. Then add an A11 case: deleting an
   email's id through `MeetingService` emits nothing under `communication.*`.

2. `docs/rfcs/RFC-0006-joined-table-inheritance.md:1461`. The S4 "Must not touch" line is contradicted by the build and
   was never amended. It lists `integrated-entity-repository.ts` and "the read surface from S3", and the slice touches
   both:
   - `runtime/base-classes/integrated-entity-repository.ts:95-121`, the two `deriveColumns` calls;
   - S3's `<Child>Flat` alias, `templates/entity/new/backend/repository.ejs.t:236-244`, the index-signature strip.

   Each change is justified in the as-built bullets (`match:` fill on the two runtime inserts; `<Child>Flat` was
   `never`), and both are review-round fixes. But a reader of the plan line is told the opposite of what landed.
   **Scenario:** S7's builder reads "must not touch `integrated-entity-repository.ts`" and assumes the S4 tip has no
   `match:` handling there. **Fix:** amend the line to name the two exceptions and point at the as-built bullets.
   **DECISION:** both are scope changes against the plan, so Doug should ratify them.

3. `docs/rfcs/RFC-0006-joined-table-inheritance.md:1506-1507` (the "Pair write" as-built bullet) says `update` "finds the
   **child** row first (updated, or selected when the patch has no child keys) and only then updates the base". That is
   the order before review fix R1#8. The code always selects the child row first (scoped), then updates the base, then
   updates the child's own columns (`repository.ejs.t` `pair_update` branch; baseline
   `meeting.repository.ts` `update`). The later "Child update order" bullet (`:1557`) describes the code correctly, so
   the RFC contradicts itself. **Scenario:** a reader takes the first bullet and concludes that a swallowed base guard
   error can leave the child half-written, which is exactly what R1#8 fixed. **Fix:** replace the parenthetical with "the
   child row is selected (scoped) first".

4. `docs/rfcs/RFC-0006-joined-table-inheritance.md:618` (the §4.1 table, `delete` row) and `:910-911` (§8 cost table,
   Update and Delete rows). The statement counts are stale. The delete row says `baseRepo.delete(id, tx)`, 1 statement,
   but the code runs a scoped child `SELECT`, then `baseRepo.delete`, inside `inTransaction`. That is 2 statements, plus
   `BEGIN`/`COMMIT` when no `tx` is passed (`repository.ejs.t:802-810`). §8's Update row ("1 or 2 updates") and Delete
   row ("1 statement") leave out the same child `SELECT`. The as-built bullet notes the check ("after the same child
   check"), but the tables were not updated (R1#10 fixed the update row's order, not these). **Fix:** add the child
   `SELECT` and the transaction to both rows.

5. `src/__tests__/fixtures/inheritance-fixtures-agree.test.ts:67-83`. The test is cited as the gate that holds the two
   `catalog_entry` copies identical, but it never compares them. It compares only the entities in
   `test/fixtures/inheritance/entities/` (`family`), and `catalog_entry` is not there. Three places claim it covers them:
   both YAML headers (`test/fixtures/entities/catalog_entry.yaml:4-5` and
   `test/scaffold/entities/catalog-entry-scaffold.yaml:4-5`, "Keep field-identical … (inheritance-fixtures-agree.test.ts)")
   and RFC §13.1 (`:1137-1138`, "fails when a shared entity differs"). **Scenario:** someone edits `price_cents` in one
   copy, and the baseline and the integration suite then test two different entities while the cited gate stays green.
   This gate cannot fail on its own subject. **Fix:** add `catalog_entry` to the compared names, as an explicit list
   alongside `family`, not a sweep over every name in two locations (unrelated baseline and scaffold entities differ
   legitimately). Or drop the claim from the two headers and qualify §13.1.

### Nits

6. The RFC still describes the pre-S4 shape in several places:
   - **§6 sketch.** `:796`: the child's `upsertByNaturalKey` returns `{ row, created }`; the code returns
     `{ row, created, baseCreated }` (§4.2 and as built say so). `:826`: the base takes `input: CommunicationCreate`, a
     type that does not exist; the code takes `Partial<Communication>`. The "Shared runtime" block (`:760-780`) does not
     list `MatchColumnImmutableError`, `OutOfScopeWriteError`, `upsertSet`, `assertBaseOnlyKind`, `fillDerivedColumns`,
     `DerivedColumn` or `ParentSource`. `:782` says `BaseService` gains `baseEntityName` and the pre-update read, but it
     also gains `baseSliceKeys` and `emitUpserted`. `BaseRepository.deriveColumns` is not mentioned.
   - **§4.2.** Step 3 (`:654`) says the child statement ends `RETURNING *`. The code returns `*, (xmax = 0)`, which is
     where `created` comes from. `:660` says "Both rows go through `stampTenant`". The child row copies the base row's
     tenant (as built says so).
   - **§4.1.** `:629-630` says `KindRequiresChildError` names "the child's create use case". The code names
     `<Child>Service.create` (`templates/_shared/inheritance.mjs`, `createPath`; test `inheritance-writes.test.ts:484`).
   - **Phase R bullet.** `:1599` says "Studio's API tab lists the three kinds". After R2 there are six repository kinds and
     five service kinds (`tools/studio/src/inspector/surface-kinds.ts:88-121`).

7. `src/derived/api/entity.ts:110-111`. The `writesDisabledBy` comment gives a reason that S4 ended: "a child's inherited
   `create` would insert a row with no `id`". S4 overrides `create` with the pair write. As built (`:1551-1553`), the
   reason use cases stay off is that the flat DTOs are S5's, and `types.ts:187` already says "until S5's flat DTOs".
   **Fix:** give both comments the same reason, and say that S5 deletes the branch.

8. `docs/rfcs/RFC-0006-joined-table-inheritance.md:1491-1499`. The cast list says "the count is what is in the emitted
   code" and lists all three `as unknown as` casts, but it leaves out single casts that the emitted child repository
   has:
   - `{ ...childRow, <rel>: baseRow } as <Child> & { … }` in `flat()`;
   - `as typeof this.table.$inferInsert` in `childValues()`;
   - `(patch as Record<string, unknown>)` in `update`;
   - `input as Record<string, unknown>` in the base upsert.

   **Fix:** list them, or say the list is the cross-seam casts only.

9. `docs/rfcs/RFC-0006-joined-table-inheritance.md:1037`. OQ-14 is still listed under "11.2 Open", but S4 built its
   default (a soft-deleted match is updated and stays deleted) and two tests pin it (`inheritance-writes.test.ts:311`,
   `:645`). **DECISION:** Doug to confirm the default, then move OQ-14 to §11.1.

10. **DECISION (behaviour change outside the family): home-module imports.** Every module that composes another
    entity's repository now imports that entity's module instead of providing the repository itself. That changes 29 of
    30 render-golden `*.module.ts` files and every composing baseline module, including entities with no `inherits:`.
    The change follows ADR-002 (revised), whose existing `exports` comment in `module.ejs.t` already says not to provide
    a composed repository locally. The as-built note and the PR body document it. It is still a DI change for every
    consumer, so Doug should ratify it. Three existing assertions were rewritten to match, each at the same strength
    (exact line, count 1):
    - `src/__tests__/backend/target-naming.test.ts:105`, `:152`, `:185` and `:316-317`;
    - `test/smoke/run-smoke-capability.ts:494-501` (#632: `CrewsModule` import plus `forwardRef`).

    The test name at `target-naming.test.ts:313` ("imports and provides it once") is now stale: the module no longer
    provides it.

11. **DECISION (an existing assertion changed).** `src/__tests__/cli/inheritance-ddl.test.ts:324-366`. S2's "natural_key:
    alone changes no emitted byte" (`expect(a).toEqual(b)`) became "only the repository and the service differ". The new
    form is still exact: it asserts the precise set of differing files, the upsert's presence and its conflict target.
    The as-built note records the change ("A fixture-test premise ended"). Listed only because it changes an existing
    assertion.

### Checked and fine

- **A6:**
  - `create` writes both rows in one `inTransaction`, the base half through `baseRepo.create` (`repository.ejs.t`
    `pair_create`).
  - A failing child insert rolls the base back: `inheritance-writes.test.ts:132`, which can fail on its subject (with no
    transaction the base row survives).
  - A caller's transaction is joined (`:140`).
  - `update` bumps the base `updated_at`, including on a child-only patch (`:160`, `:174`).
  - A `kind` key throws `KindImmutableError` and writes nothing (`:181`).
  - A guard error swallowed in the caller's transaction leaves nothing half-written (`:588`).
- **A7:**
  - Two upserts leave one base row and one child row, and the second reports `created: false` (`:243`).
  - Another kind throws `KindMismatchError` and writes nothing, also when the caller owns the transaction and continues
    (`:274`, `:283`; the conflict's `WHERE kind = excluded.kind` is pinned in the SQL test at `:557`).
  - Tenants are isolated (`:301`), and the conflict target is tenant-prefixed (`("tenant_id","source","external_id")`, `:568`).
  - The orphan repair reports `created` / `baseCreated` separately (`:605`).
- **A11:** `create`, `update`, `delete` and `upsert` emit under both names. The base slice is cut by `<EU>_BASE_KEYS`,
  the pre-read is the flat row (`findWithBase`), base-field change events go under the base's name, and a delete through
  the base emits the base name only (`inheritance-writes.test.ts:409-470`; unit `inheritance-writes.spec.ts:192-290`).
- **A5 insert fill:**
  - The derived column is filled by a scalar subquery in the same insert, and a caller's value is ignored (`:327`, `:337`).
  - It is re-derived when a followed foreign key changes, and M4 is enforced with `MatchColumnImmutableError` (`:350`).
  - 23502 / 23503 come from the driver, unmapped, as §2.4 says (`:371`).
  - For a column where every FK is nullable, `coalesce` runs in declaration order (`:381`).
  - The Integrated and Metadata upserts call `deriveColumns` (`integrated-entity-repository.ts:96`, `:121`;
    `metadata-entity-repository.ts:66`), each with a unit test.
- **Base guards (§4.1):**
  - The repository's `update` refuses `kind` for any base with a discriminator, including `matrix-discriminator-no-child`.
  - The service's `create` and `upsertByNaturalKey` refuse a kind that has a child table (`assertBaseOnlyKind`).
  - Base-only kinds create and upsert normally (`inheritance-writes.test.ts:472-525`).
- **The `IBaseRepository` measurement:** recorded in §6 and as built. `test/baseline-type-assertions.ts` asserts that
  `MeetingFlat` is not `never` and reads real fields off every write and its service forward, with a `@ts-expect-error`
  that cannot rot.
- **Upsert semantics:** `SET` never carries `id`, the kind, the tenant, the natural-key columns, `createdAt` or, under
  `user_tracking`, the user column. A `SET id = id` no-op keeps `RETURNING`. The user-axis guard throws
  `OutOfScopeWriteError` (`:654`, `:663`). OQ-14's default holds.
- **A child of a keyless base** has no upsert: the derivation (`familyWriteSurface`, `family-reads.test.ts`), the
  `matrix-family-no-natural-key` golden, and the smoke's parcel/crate pair checked by `tsc` plus
  `assertFamilyWithoutNaturalKey`.
- **ADR-046 R2:**
  - Write bodies print by `m.kind`, one kind per body; signatures print `m.name` / `m.params[i].name`.
  - `upsert_own` / `upsert_through_base` come from the derivation, not from `with_base`.
  - The `family*` write locals are deleted, and `naturalKeyIndexOf` / `inheritanceBaseOf` are the one reader of the marker.
  - `inheritanceBase` is a required input.
  - The allowlist did not grow (`no-name-derivation.allowlist.ts` is not in the diff).
  - The golden set matches the as-built list, and 29 of 30 matrix modules were re-blessed, with
    `matrix-self-fk/categories.module.ts` the one unchanged.
- **Module wiring:** a child's module imports its base's module first, once, and the base exports its repository.
  `forwardRef` appears only where the graph reaches back (`meetings.module.ts` → `MeetingTranscriptsModule`).
- **Sequencing:** `writesDisabledBy` keeps its `inherits` branch, so a child has no write use case or route (baseline
  `meetings/use-cases/` holds only `find-by-id` and `list`), as the as-built note says.
- **Inherited-methods comment:** the `// Inherited from BaseRepository: … create, update, delete` comment on a child now
  lists methods the class overrides. That is the named #893 expectation (`inherited-comment-expectation.test.ts`), not
  new drift.
- **Public-repo rule:** fixtures, comments and tests name no host application.
