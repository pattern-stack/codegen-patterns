# Lane `inh-s4-build` — #875 slice S4: pair writes and the upsert

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/lanes/COMMON.md` first; it binds you.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-875-s4-inherits-writes`
- **Branch:** `dugshub/875-s4-inherits-writes`, stacked on `dugshub/875-s3-inherits-reads`. **Diff base:
  `dugshub/875-s3-inherits-reads`** (use it in place of `main` everywhere COMMON.md says `main`).
- **Your scope:** RFC-0006 §13.2 **S4**, revision 3. Read §2.4 (the `match:` fill and the nullable-match CHECK), §4
  (all), §5's event paragraphs, §6, §11 (OQ-14: a soft-deleted match is updated and stays deleted) and every "as
  built" note S1–S3 left in the RFC. S3 built the reads (`findWithBase`, `<Child>Flat`, `inheritance.ts`): reuse
  them, do not touch them.

## First task — measure, then record

Measure whether `override create(input: <Child>Create, tx?) : Promise<<Child>Flat>` and `override update(...)`
satisfy `IBaseRepository` (`runtime/base-classes/base-service.ts`) **under the smoke's consumer tsconfig** (not only
`bun run typecheck`). Write the result into the RFC (§6 / S4 as built). If they do not, take the RFC's fallback:
keep the inherited signatures, add the flat-typed methods under their own names, and make the inherited ones throw
on a child. Either way, no path may write a child row without its base row.

## What to build

1. **Child repository** (`repository.ejs.t`): `create` / `update` / `delete` overrides per §4.1 — split by owner
   (`splitByOwner`), base write through the **injected base repository** (so `stampTenant` / `withTimestamps` apply
   with the base's behaviors), one transaction (`inTransaction`: `tx ? fn(tx) : db.transaction(fn)`); `update` always
   runs the base update (bumps `updated_at`); a `kind` key throws `KindImmutableError`; `delete` deletes the base row
   (hard → FK cascade; soft → base `deleted_at`, child leaves scope via S3's `EXISTS`).
   `module.ejs.t` wires the base repository into the child's module.
2. **Base repository / service guards:** base `update` refuses `kind` (`KindImmutableError`); base service `create`
   (and `upsertByNaturalKey`) refuse a kind that has a child table (`KindRequiresChildError`, naming the child's
   create path). Base-only kinds write normally.
3. **`upsertByNaturalKey`** on the base and every child (§4.2): base `INSERT … ON CONFLICT (<tenant-prefixed natural
   key>) DO UPDATE SET … RETURNING *, (xmax = 0) AS created`; kind guard → `KindMismatchError` (rolls back, writes
   nothing); child `INSERT … ON CONFLICT (id) DO UPDATE`. `SET` carries the columns the input carries plus
   `updated_at`, never `id` / `kind` / tenant / natural-key columns / `created_at`; an absent key is left alone, an
   explicit `null` clears. Result `{ row: <Child>Flat, created }`. A soft-deleted match is updated and stays deleted.
4. **`match:` fill** (§2.4): the generated insert fills a derived `match:` column with a scalar subquery on the
   parent's primary key in the **same statement** (`(SELECT kind FROM communications WHERE id = $1)`); an update that
   changes the FK re-derives it; a missing parent then fails NOT NULL / the CHECK, mapped to the same error as an FK
   violation. Applies to create, update and upsert, on any entity with a derived match column (e.g.
   `communication_participant`, `communication_note`) — not only family members. The discriminator-as-match-column
   case (`communication_part`) is **not** filled: the kind comes from the write path, and the FK checks it (M2).
   M4: a matched column is immutable while the FK is unchanged.
5. **Runtime** (`runtime/base-classes/`): `inheritance.ts` gains `splitByOwner`, `inTransaction`,
   `KindImmutableError`, `KindMismatchError`, `KindRequiresChildError`; `base-service.ts` gains an optional
   `baseEntityName` (a child write emits `<child>.<event>` with the flat snapshot **and** `<base>.<event>` with the
   base slice — A11), the pre-update read as a protected overridable method (the child's reads the **flat** row, so
   base fields don't all look changed), and upsert events (`created` / `updated` from the flag, both names, no
   per-field change events). A delete through the base emits `<base>.deleted` only.
6. **Service** (`service.ejs.t`): forward `upsertByNaturalKey`; wire `baseEntityName` for a child.
7. **Use cases and routes:** keep the child's HTTP write routes and write use cases **off** until S5 — the flat
   create/update DTOs are S5's, and a child-shaped DTO cannot carry the base fields the pair write needs. Writes are
   reachable through the repository and the service in this slice. Record this sequencing in the RFC (§13.2 S4/S5).
8. **Integration test** `test/scaffold/tests/inheritance-writes.test.ts` (A6, A7, A11, and A5's fill clause):
   - child `create` writes both rows in one transaction; a failing child insert rolls back the base row;
   - `update` across both tables bumps the base's `updated_at`; a `kind` key throws `KindImmutableError`;
   - `delete` hard-deletes both (and, on `communication_part` with `soft_delete`, the child leaves child reads);
   - `upsertByNaturalKey` twice with one key → one base row, one child row, second call `created: false`; a key that
     exists under another kind throws `KindMismatchError` and writes nothing; one tenant's upsert never touches
     another tenant's row with the same key; a soft-deleted match stays deleted;
   - a derived match column is filled by the insert (the caller passes none) and re-derived when the FK changes;
     `communication_participant` creates through its generated `create`;
   - events: a child create/update/delete/upsert emits under both names with the right payload slices; a base
     delete emits the base name only.
   Prove one gate fails on its subject: drop the transaction from the child `create` and watch the rollback case go
   red; restore.

## Must not touch

The S3 read surface; `runtime/base-classes/integrated-entity-repository.ts`; the DTO templates and the frontend.
A change under `runtime/base-classes/` is not validated by `bun run typecheck` alone (charter I9): run the smokes.

## Gates (after your last edit; paste tails)

`bun run typecheck`, `just test-unit`, `just test-baseline` (list every changed pre-existing snapshot and say why;
#680 untouched), `just test-smoke`, `just test-integration`, plus `just test-smoke-capability` and
`just test-smoke-subsystems` (the `BaseService` change reaches them).

## Report

Per COMMON.md. Include the IBaseRepository measurement and which path you took, the generated `MeetingRepository`
`create` and `upsertByNaturalKey` verbatim, and the emitted SQL of one upsert.
