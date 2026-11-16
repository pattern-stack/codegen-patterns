# S5 review fixes — lane `inh-s5-build`

The Opus review of `dugshub/875-s5-inherits-http` @ `dcd201f8` returned **REVISE**: A10 and the rest of A2 are met
and every gate is green, but there is a charter I4 break and a tsc regression. Fix on the same branch as new commits
(no history rewrite); COMMON.md still binds you. Re-verify each finding before fixing it. **DECIDED** items are
coordinator decisions — do them as stated.

1. **BLOCKER (I4) — a child list with an include is two statements** (`use-cases/list.ejs.t:175-181`: `listFlat`
   then `findManyWithBase(ids, {with})`). **DECIDED: fold `with` into `listKind`** — the S3 read surface may change
   for this. `listKind(kind, query, childWith?)` builds `with: childWith === undefined ? <base>KindJoins([kind]) :
   { [CHILD_KEY_BY_KIND[kind]]: { with: childWith } }`; `listFlat<W>(query, opts?: { with?: W }): Promise<<Child>Flat<W>[]>`;
   the service forward is generic; the use case drops the second branch. **Gate:** give one fixture child
   `api.includes.list` and add a statement-count case (the counting client in `inheritance-reads.test.ts`): a child
   list with an include is **1 statement**, returns flat rows with the include, no `communication` key; and an HTTP
   case `GET /meetings?include=transcripts`. Show the count case red on the two-statement code.
2. **Regression — `search` on a child no longer compiles** (`use-cases/search.ejs.t:55` against the base-typed `where`
   in `list.ejs.t`), and 3. **a child-column `sort_by` silently falls back to the default** (`list.ejs.t:134`).
   **DECIDED: one child-rooted path for both**, as RFC §3.2 already says ("sorting a child list by a child column is
   the child's `list()`"): when the sort column is a **child** column, or the read is a child `search` (R7 guarantees
   a child's queries name only its own columns), the use case reads through the child's own
   `list({ with: { communication: true, ...include }, sort, where })` and `flattenBase` — one statement, scope via
   the child's own scope (tenant + the base `EXISTS`). A base-column sort (and the default) stays on `listKind`.
   Count: the child-rooted path counts with the child's own scoped `count(where)`; the base path keeps `countFlat`.
   A truly unknown `sort_by` keeps today's plain-entity behaviour (whatever that is — do not change it here).
   **Gates:** a child fixture with a `search` query (in baseline so tsc covers it, and scaffold); integration cases:
   `GET /meetings?sort_by=title` is ordered by title; a child search filters on its own column; both 1 statement.
   Show the search fixture red (TS2322) before the fix.
4. **One rule for unknown keys — DECIDED: revert families to the default (strip)**, i.e. drop `strictDtos`, so a
   family DTO behaves like every other DTO. Making every DTO strict is a generator-wide behaviour change that the
   frontend client may not survive (unverified), so it goes to Doug as a separate question. Update the tests that
   asserted a 400 for `{kind}` / `{tenantId}` on a child: assert instead that the key cannot **set** anything (the
   row's kind / tenant are unchanged), which is the property that matters. Record in the RFC that unknown keys are
   stripped as everywhere else, and that strict-everywhere is an open follow-up.
5. **OpenAPI coherence:** register `Create<Base>Dto` only when `generateCreate` is true. **DECIDED:** register the
   `<Base>OfKind` union **only when a route returns it** — in v1 none does, so drop its registration and the
   `verify-openapi` check for it; keep the Zod schema file (programmatic callers of `findAllKinds` use it). RFC: say
   no v1 route returns the union. Fix the RFC's "kind key" → "relation key" (`:1551`, OQ-5's wording in §11.1 may
   stay as decided, but say in the as-built note that the key is the child's relation key).
6. **`kindError`** (`controller.ejs.t:218-235`): keep it in the template; make `createPath` the **route**
   (`POST /meetings`), not a class/method name; make the body match `ErrorResponseDto` (include `statusCode`, as the
   `$ref` promises — and fix `resolveInclude`'s body the same way if it is the same template); fix the `:220` comment
   (§11.1 decides nothing about statuses).
7. **Stale docs:** (a) the child list use-case header (`list.ejs.t:38`); (b) the service's "Inherited from" comment
   (`service.ejs.t:276`) — apply the repository's filter; (c) the dangling double JSDoc in
   `find-meeting-by-id.use-case.ts:14-24`; (d) RFC `:1587` "18" → the true number; (e) RFC §6 "Generated on the child
   repository" gains `listFlat` / `countFlat`; (f) RFC: the frontend smoke has no family, so "compiles unchanged"
   proves nothing (S6 covers it); (g) the S5 as-built note states that `listKind`'s `OrphanBaseError` now reaches
   `GET /meetings` (one orphan base row makes the page containing it a 500), per §3.3.
8. `inheritance-http.test.ts:205` "cannot be patched or deleted" only tests PATCH — test DELETE too, or rename.
9. `controller.ejs.t:7` tests `generateWrites` twice on the import line.

Gates after your last edit (paste tails): `bun run typecheck`, `just test-unit`, `just test-baseline` (list changed
pre-existing snapshots by category; #680 untouched), `just test-smoke` (incl. openapi), `just test-integration`,
`just test-smoke-frontend`. Report per COMMON.md with a finding → commit / test table.
