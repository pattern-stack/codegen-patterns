# GATE-2 — Default list sort without `timestamps`, and an honest `test-smoke-integration`

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
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
- The separate `src/jobs/**` **error** check goes with the partition — it is a subset of what step 9 now fails on
  (Found #3). Its vacuity guard stays.

Shipped as described.

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

Shipped. **No other peer needed it**: after this one mapping the generated project compiles with zero diagnostics, so
`@nestjs/common` was the only package split across the two trees in a way that reached a type position.

### If something cannot be fixed

A residual diagnostic gets a **named single-purpose expectation**: the exact file + error code + a comment carrying
the issue number, asserted to be present *and* to be the only one. Never a directory carve-out, never a message
predicate. The expectation fails if the error changes shape or disappears, so it cannot rot.

## Out of scope

- The `clean` backend pipeline and `just test-smoke-junction-clean` (#602, charter §5 non-goal).
- #603 (`BaseRepository.table` typing) — REL-2/REL-3.
- Keyset paging itself (the v1 engine stays offset; the seam is unchanged).

## Found during implementation

1. **Two test assertions were too strict, and the emitted prose is why.** The first draft asserted
   `not.toContain('created_at')` over the whole timestamp-less render, and `not.toContain('KEYSET SEAM')`. Both failed
   — because the replacement comments *explain* that there is no `created_at` and that there is no keyset seam, which
   is exactly what a generated file should say. The assertions were made **more precise**, not weaker: `.createdAt` is
   matched as a property access (`/\.createdAt\b/`, the form that does not compile), plus a check that no
   non-comment line mentions it at all; and the seam is matched as its directive (`/^\s*\/\/ KEYSET SEAM \(/m`)
   rather than as a phrase. Worth stating as a rule: when a fix makes generated prose talk about the thing it removed,
   assert on the *code shape*, not on the words.
2. **`projectDir` had to default to keeping, not dropping.** The first cut dropped every absolute location when no
   `projectDir` was passed. That is a silent-pass risk in the three harnesses that do not pass one — precisely the
   failure I9 exists to prevent. Inverted: an absolute location is dropped only when we *know* it is outside the
   project. All four call sites now pass their directory anyway, so the ambiguous case does not arise in practice;
   the default is the safe one for whatever calls it next.
3. **The jobs-tree error check became dead code**, not just the `otherErrors` partition. Once step 9 fails on every
   diagnostic in the project, `jobErrors` is a subset of what already failed. Deleted; the jobs **vacuity guard**
   stays and is now the only thing that file does for `src/jobs/**` — and it matters more, because a gate that fails
   on nothing because nothing was emitted is the other way to be dishonest.
4. **No baseline or snapshot churn.** Neither `test/baseline/**` nor `test/junction/__snapshots__/**` contains a list
   or search use-case (`grep -c orderBy` over both snapshots → 0), so the template change is invisible to them.
   Checked before running, because a surprise snapshot diff here would have been the thing to explain.

## Acceptance — all met

Output from the run made **after the last edit** (charter I9).

| Gate | Result |
|---|---|
| `bun run typecheck` | **exit 0** |
| `bun run build` | **exit 0** |
| `bun run test` | **exit 0** |
| `just test-all` | **exit 0** — unit **3176/3176** (16 new) · baseline · 6 smokes · junction · integration-emit · smoke-integration |
| `just test-integration` | **exit 0** — 64 pass · 2 pre-existing skip · 0 fail |
| `just test-post-publish` | **exit 0** |

- `just test-smoke-integration` is green **with no carve-out**: `grep -c "out of scope"` over the whole `test-all`
  log → **0**.
- **The new check was proven non-vacuous**, which is the risk a location-scoped check carries when the harness
  compiles against out-of-tree sources. On a kept project (`KEEP_SMOKE_DIR=1`), with a baseline of 0 errors:

  | Injected defect | Reported |
  |---|---|
  | re-introduce #604 (`desc(accounts.createdAt)` in the list use-case) | **1** — `…list-accounts.use-case.ts(45,31): error TS2339: Property 'createdAt' does not exist…` |
  | break a relative import (`from '../nope-does-not-exist'`) | **1** — `…(5,32): error TS2307: Cannot find module…` |
  | restore | **0** |

  Both live in `src/modules/**` — outside `src/integrations/**` and `src/jobs/**`, i.e. exactly what the old
  carve-out printed and passed.
- No generated `list-*.use-case.ts` or `search-*.use-case.ts` references `.createdAt` for an entity without
  `timestamps` (10 rendering tests, both templates × both behavior shapes).
- CLAUDE.md › Known-red gates: the #604 paragraph is gone, replaced by the rule that now holds — location-only
  scoping everywhere, and what to do instead if something truly cannot be fixed.
- **Nothing needed a named expectation.** Both residual classes were fixable at the root.

## Risks — outcome

- **`id desc` is not a valid default for a non-UUID primary key.** Open, and unchanged by this PR: every pipeline
  emits `id: uuid('id').primaryKey().defaultRandom()`, and the existing tie-break already assumed `.id`
  unconditionally. If a configurable primary key ever lands, the default sort is one of its call sites.
- **Removing the carve-out surfaces more than the one known error.** It did not: after the #604 fix and the
  `@nestjs/*` mapping, the generated project compiles with **zero** diagnostics. The seven printed errors were the
  whole set.
- **Mapping `@nestjs/*` hides a real dual-copy problem in consumers.** It does not: the duplication is an artifact of
  *this harness* compiling one program out of two trees. A real consumer installs one copy; the dual-copy hazard for
  consumers is covered by `just test-post-publish` (green) and documented in `docs/CONSUMER-SETUP.md`.
- **A location-scoped check goes vacuous in a harness that compiles out-of-tree sources.** Real enough to test for
  rather than reason about — see the injection table under Acceptance.

## Definition of done (charter §9)

Gates green from the run after the last edit · this spec corrected to post-implementation truth and marked
`Implemented` · CLAUDE.md corrected · epic #579 body (task row) + log entry updated.
