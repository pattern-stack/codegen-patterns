# GATE-2 — Default list sort without `timestamps`, and an honest `test-smoke-integration`

**Status:** Draft
**Date:** 2026-09-17
**Issue:** #604 · **Epic:** #579 · **Project:** #578
**Depends on:** DRZ-2 (#584) · **Blocks:** epic #579 closing honestly
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) · CLAUDE.md

## Why

DRZ-2 deleted the smoke *message* filters (#576), and the last place a generated-code error can still hide is a
**scope carve-out**: `just test-smoke-integration` fails only on diagnostics located under `src/integrations/**` and
`src/jobs/**`, and prints the rest as

```
7 tsc error(s) OUTSIDE src/integrations/** (out of scope — not failing):
```

Six of those seven are **#604** — a real generated-code bug that has been visible and un-gated. Charter **I9** says a
gate reports what it found; a carve-out that prints a real defect and passes anyway is the same failure mode as a
filter, one step further out. This PR fixes the defect, removes the carve-out, and leaves the epic's gate story with
nothing swept under it.

## Charter invariants this PR touches

- **I9 gates are honest** — the point. After this PR every `tsc` diagnostic located in the generated project fails
  `test-smoke-integration`. If something genuinely cannot be fixed, it gets a **named single-purpose expectation tied
  to an issue number**, never a directory carve-out and never a message predicate.
- **I2 generated means regenerated** — the fix is in the template, driven by the YAML (`behaviors: [timestamps]`), not
  a hand-edit or a runtime guard.
- **I11 scope discipline** — `clean-lite-ps` is the pipeline in scope; the `clean` pipeline's list query emits no
  default sort at all, so there is nothing to fix there (verified).

## Part A — #604: the default sort assumes `created_at` exists

### Root cause

`templates/entity/new/clean-lite-ps/use-cases/list.ejs.t:43-46` emits:

```ts
const orderBy: SQL =
  col === undefined
    ? sql`${desc(accounts.createdAt)}, ${desc(accounts.id)}`
    : sql`${dir(col as never)}, ${desc(accounts.id)}`;
```

`resolveListQuery` defaults `sortBy` to `DEFAULT_SORT_BY = 'created_at'` (`runtime/http/pagination.ts:37`), so an
unrecognised or defaulted `sort_by` lands in the first branch. For an entity whose YAML declares no `timestamps`
behavior the emitted table has no `created_at` column, and the generated file does not compile:

```
src/modules/accounts/use-cases/list-accounts.use-case.ts(41,31): error TS2339:
  Property 'createdAt' does not exist on type 'PgTableWithColumns<{ name: "accounts"; … }>'.
```

Six of the eight `integration-patterns` fixture entities hit it. **Pre-existing and version-independent** — DRZ-2
reproduced it byte-identically on `dugshub/599-honest-gates` at `drizzle-orm@0.45.2`.

### Fix

Branch the default on the `hasTimestamps` local (already exported by
`templates/entity/new/clean-lite-ps/prompt-extension.js:1544` and already read by `entity.ejs.t` and
`repository.ejs.t`). With timestamps, nothing changes. Without, the default becomes the primary key alone:

```ts
const orderBy: SQL =
  col === undefined
    ? sql`${desc(accounts.id)}`
    : sql`${dir(col as never)}, ${desc(accounts.id)}`;
```

This is **keyset-compatible**, which is the property the tie-break exists for: `id` is a UUID primary key, so
`id desc` alone is already a total order over the table — the same guarantee `(created_at, id) desc` buys when
`created_at` can repeat. `computeNextCursor` (`runtime/http/pagination.ts:200-211`) already degrades correctly: it
returns `null` when a row carries no `createdAt`, and the v1 engine is offset paging anyway, so a timestamp-less
entity simply has no cursor — it does not get a *wrong* one.

The doc comment and the KEYSET SEAM note in the same file both state `created_at desc, id desc` as fact; both are
branched with the code, or a reader of a timestamp-less entity's generated file is told something false.

### Second site, same defect

`templates/entity/new/clean-lite-ps/use-cases/search.ejs.t:57` hard-codes
`orderBy: asc(<plural>.createdAt)` in exactly the same way. It is gated on `hasSearchQuery`, so today's fixtures do
not hit it — a timestamp-less entity that declares a `queries: - name: search` block would. Fixing one and not the
other would leave a landmine that only the (now honest) gate finds later, so both are fixed. Strictly speaking this
is beyond #604's title; it is the same one-line rule and is recorded here rather than left for someone else.

### Scope check — other pipelines

`grep -rn "desc(\|orderBy" templates/` finds no other default-sort emission. `templates/relationship/new/use-cases/
list.ejs.t`, `templates/entity/new/backend/application/queries/list.ejs.t` (the `clean` pipeline) and
`templates/entity/new/clean-lite-ps/use-cases/list-with-fields.ejs.t` emit no `orderBy` default at all. The
`q.hasOrder` emissions in the repository templates come from an explicit `queries: … order:` clause in the YAML, which
names its own column — not a default.

### Test

A unit test rendering both templates against a **timestamp-less** fixture and a timestamped one, asserting:

- no `.createdAt` anywhere in the timestamp-less render (the assertion that would have caught #604);
- the timestamped render still emits `desc(<plural>.createdAt), desc(<plural>.id)`;
- the `id` tie-break survives on the caller-supplied-sort branch in both;
- the doc comment matches the emitted behaviour in both.

Lives beside the other clean-lite-ps render tests (`src/__tests__/clean-lite-ps/`), using the same
`buildCleanLitePsLocals` + `ejs.render` harness, so it runs in `just test-unit` → `just test-all` → CI.

## Part B — remove the carve-out from `test-smoke-integration`

### What the carve-out is

`test/smoke-integration/run.ts:317-339` partitions `tsc` output into `integErrors` / `jobErrors` / `otherErrors` by
path prefix and fails only on the first two. The header comment (`:44-50`) justifies it with two pre-existing
`bus.ts` errors — which **DRZ-2 fixed** (#575), so the stated reason no longer exists. The partition also reads only
`tsc.out`, dropping anything tsc writes to stderr.

### Fix

- Delete the `otherErrors` partition. One scoped list; **any** diagnostic in the generated project fails the gate.
- Scope by reusing `test/smoke/_consumer-errors.ts` — the same helper the other three smokes use, so there is one
  definition of "a diagnostic this gate owns" in the repo.
- Read `tsc.out + tsc.err`.
- Keep both vacuity guards (`no generated files under src/integrations/**`, `no files under src/jobs/**`) and the
  per-tree file counts. They are what stops the gate passing green on an empty project, and they get *more*
  load-bearing once the error check is no longer partitioned by tree.

### `_consumer-errors.ts` needs one addition

The helper drops a diagnostic whose location starts with `../` or sits in `node_modules`. That is sufficient for the
other three smokes, which compile a self-contained project. This harness deliberately compiles the emitted tree
**against in-repo runtime and surface sources** via tsconfig `paths`, so a diagnostic can be located at an *absolute*
path outside the project — which the helper would keep. Add an optional `projectDir`: when given, an absolute location
outside it is dropped too. Diagnostics inside this repo's own `runtime/` are `bun run typecheck`'s job, which is in
`test-all` since GATE-1; they are not this gate's subject. Call sites that already have their tmp dir pass it, and the
new behaviour gets its own unit tests.

### The 7th error, fixed at the root

```
src/main.ts(115,27): error TS2345:
  Argument of type 'import("<tmp>/node_modules/@nestjs/common/…").INestApplication<any>'
  is not assignable to parameter of type 'import("<repo>/node_modules/.bun/@nestjs+common@10.4.22/…").INestApplication<any>'.
```

`installRequesterContext(app)` — `app` is the tmp project's `INestApplication`, the function is typed with the repo's,
because the tsconfig maps the runtime at repo sources while `@nestjs/common` resolves per-file. **Two physical copies
of one package**, the same failure mode GATE-1 fixed for `test/scaffold` (its item 4: a duplicate `@nestjs/common`
turned every `NotFoundException` into a 500).

Fix: map `@nestjs/*` in the harness's rewritten tsconfig onto the tmp project's own `node_modules`, so both halves of
the program see one identity. `paths` are consulted for every non-relative specifier in the program, including from
the repo-source files, which is exactly the unification needed. If other shared peers turn out to have the same split,
they get the same treatment — this is a resolution fix, not a suppression.

### If something cannot be fixed

A residual diagnostic gets a **named single-purpose expectation**: the exact file + error code + a comment carrying
the issue number, asserted to be present *and* to be the only one. Never a directory carve-out, never a message
predicate. The expectation fails if the error changes shape or disappears, so it cannot rot.

## Out of scope

- The `clean` backend pipeline and `just test-smoke-junction-clean` (#602, charter §5 non-goal).
- #603 (`BaseRepository.table` typing) — REL-2/REL-3.
- Keyset paging itself (the v1 engine stays offset; the seam is unchanged).

## Acceptance

Output from the run made **after the last edit** (charter I9).

- `bun run typecheck && bun run build && bun run test` green.
- `just test-all` green, including the new unit test.
- `just test-integration` green.
- `just test-post-publish` green.
- `just test-smoke-integration` green **with no carve-out**: its output contains no "out of scope — not failing" line,
  and it fails on any `tsc` diagnostic located in the generated project.
- No generated `list-*.use-case.ts` or `search-*.use-case.ts` references `.createdAt` for an entity without
  `timestamps`.
- CLAUDE.md › Known-red gates reflects reality: the #604 paragraph goes away.

## Risks

- **`id desc` is not a valid default for a non-UUID primary key.** Every pipeline emits
  `id: uuid('id').primaryKey().defaultRandom()`, and the existing tie-break already assumes `.id` unconditionally, so
  this adds no new assumption. If a configurable primary key ever lands, the default sort is one of its call sites.
- **Removing the carve-out surfaces more than the one known error.** Then the gate is telling the truth for the first
  time. Fix at the root, or a named expectation plus an issue — time-boxed, and reported in this spec either way.
- **Mapping `@nestjs/*` hides a real dual-copy problem in consumers.** It does not: the duplication is an artifact of
  *this harness* compiling one program out of two trees. A real consumer installs one copy; the dual-copy hazard for
  consumers is covered by `just test-post-publish` and documented in `docs/CONSUMER-SETUP.md`.

## Definition of done (charter §9)

Gates green from the run after the last edit · this spec corrected to post-implementation truth and marked
`Implemented` · CLAUDE.md corrected · epic #579 body (task row) + log entry updated.
