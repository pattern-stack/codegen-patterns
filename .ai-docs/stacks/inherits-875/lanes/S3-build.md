# Lane `inh-s3-build` — #875 slice S3: relations, scope and reads

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/lanes/COMMON.md` first; it binds you.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-875-s3-inherits-reads`
- **Branch:** `dugshub/875-s3-inherits-reads`, stacked on `dugshub/875-s2-inherits-ddl`. **Diff base:
  `dugshub/875-s2-inherits-ddl`** (use it in place of `main` everywhere COMMON.md says `main`).
- **Your scope:** RFC-0006 §13.2 **S3**, revision 3. Read §2.3 (scope), §3 (all), §6 and §13 closely, and the "as
  built" notes S1 and S2 left in the RFC. Read `docs/specs/READ-1.md` (the read API: `columns` + `with` on every
  read, RQBv2, one statement) and the charter `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` §4
  (I1 one graph, I3 scope at every hop, I4 one statement, I9 gates) — this slice lives in its territory.

## What to build

1. **Two edges per child** in `buildRelationGraph` (`src/emitters/relations/build-graph.ts`, next to the
   `belongs_to` / `has_one` branches): child → base `<base name>` (to-one, `optional: false`) and base → child
   `<child name>` per child (to-one, `optional: true`), relation keys camelCased as the rest of the manifest is.
   `RelationEdge` (`src/emitters/relations/types.ts`) gains `inherits: 'base' | 'child'`. The child-to-base edge is
   the documented exception to `hopCanDropTarget` (§3.1) — say so at the exception in a comment.
2. **Base scope on the child** (§2.3): `ScopeConfig` (`runtime/base-classes/scope-filters.ts`) and its emitted twin
   `ScopeConfigLiteral` (`types.ts`) gain one optional base-scope field. When the base declares `soft_delete` or
   `user_tracking`, the child's scope gains `EXISTS (SELECT 1 FROM <base> b WHERE b.id = <child>.id AND <base scope
   on b>)`, applied in `scopeFilter` so the root (`scopeAndOn`) and every hop (`hopScope`) get it from one place.
   A tenant-only family (`communication`) emits nothing extra — the child's own tenant column carries scope.
3. **Runtime** `runtime/base-classes/inheritance.ts`, exported from `runtime/base-classes/index.ts`: `flattenBase` +
   `Flattened<R,K>`, `asKind`, `OrphanBaseError` (and only what S3 needs — `splitByOwner`, `inTransaction` and the
   write errors are S4). If you add a file another template imports, check `package.json` `files` (the
   template-src-imports gate).
4. **Generated reads** (`repository.ejs.t`, forwarded in `service.ejs.t` as READ-1 reads are): on the child
   `findWithBase`, `findManyWithBase`, the `<Child>Flat<W>` type; on the base `findAllKinds` (`kinds?` filter),
   `findKindById`, `listKind`, `countKind`, `findOrphans`, and the `<Base>OfKind` union type. All on RQBv2 with
   `columns` / `with`, **one statement each** (I4). `findAllKinds` throws `OrphanBaseError` through `asKind` on a
   row whose kind has a child table but no child row; a base-only kind narrows to the base alone.
5. **`.toSQL()` unit tests** beside `src/__tests__/runtime/base-classes/read-api-sql.spec.ts`: `findAllKinds` is one
   statement (A9), `findAllKinds({ kinds: ['meeting'] })` joins only that child, the soft-delete `EXISTS` appears on
   a child root read and in a hop into the child, and does **not** appear for the tenant-only family.
6. **Integration tests** in `test/scaffold/tests/` modelled on `relation-scope.test.ts` (A8, A9):
   - `communication_part` (soft_delete): a soft-deleted base row's child is absent from `transcriptCommunicationPart`
     reads at the root and from a hop into the child;
   - tenant: another tenant's child is absent at the root and at a hop — **and over HTTP**: until S3 a child is
     `tableScope(schema.meetings, UNSCOPED)` and `MeetingRepository` has no tenant scope, so `GET /meetings` and
     `GET /meetings/:id` read across tenants (charter I3, found in S2's review). Assert both routes are scoped, in
     `test/scaffold/tests/` beside the existing HTTP scope tests; it must go red on the S2 tree;
   - `findAllKinds` returns the union with each child under its kind key and the base-only kind bare;
   - an orphan base row (insert the base only, raw SQL) makes `findAllKinds` throw `OrphanBaseError`, and
     `findOrphans` returns exactly that row.
   Prove one new gate can fail: drop the `EXISTS` from the scope and watch the soft-delete case go red; restore.
7. **Manifest half of A12:** the relations manifest (`relations.ts`) carries both edges; assert it in the existing
   relations tests (and the baseline snapshot shows it).

## Must not touch

`create` / `update` / `delete` and the write use cases (S4); the DTO templates (S5); the frontend emitter (S6) —
but the frontend graph calls the same `buildRelationGraph`, so run `bun test src/__tests__/emitters/frontend` and
`just test-smoke-frontend` and report whether the new edges change the frontend golden; if they do, do **not**
re-bless the golden here — report it (S6 owns the frontend's handling of the marker).

A change under `runtime/base-classes/` is not validated by `bun run typecheck` alone (charter I9): run the smokes.

## Gates (after your last edit; paste tails)

- `bun run typecheck`, `just test-unit`
- `just test-baseline` (snapshot diff: the family's repository/service/relations lines only; #680 untouched — list
  every changed pre-existing snapshot and say why)
- `just test-smoke`
- `just test-integration`
- report-only: `just test-smoke-frontend` and the frontend graph golden test (see above)

## Report

Per COMMON.md. Include the generated `CommunicationOfKind` type, the `findAllKinds` method, and the `.toSQL()`
output of one `findAllKinds` call, verbatim — the coordinator shows them to Doug at CP1.
