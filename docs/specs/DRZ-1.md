# DRZ-1 — Drop v1 `relations()` const emission

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
**Issue:** #583 · **Epic:** #579 · **Project:** #578
**Depends on:** —  · **Blocks:** DRZ-2 (#584)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) · ADR-044 · PLAN §4.2

## Why

Drizzle 1.0 removes `relations` from the `drizzle-orm` root export (TS2724 on import). All three template pipelines
emit a v1 `export const <plural>Relations = relations(...)` const, so every generated project with a relationship
stops compiling on 1.0. Nothing generated *consumes* the const — it was an opt-in extension for hand-written queries
(cgp-62 r4 §4). Deleting the emission is therefore green on 0.45 **and** on 1.0, which lets this PR carry all the
mechanical snapshot churn so that DRZ-2 (the actual bump) is reviewable on its own.

The slot is left **empty**. REL-1 (#586) refills it with a whole-set `defineRelations()` manifest under ADR-044. This PR
must not pre-decide that manifest's layout (no metadata-only v2 emission here).

## Charter invariants this PR touches

- **I7 no backwards compat** — delete; no flag to keep the old const, no deprecation note in generated output.
- **I9 honest gates** — assertions that currently require the const are inverted to assert its **absence**, not deleted.
- **I11 scope** — all three pipelines lose the const (it cannot compile on 1.0 anywhere), even though later REL work
  is `clean-lite-ps`-only.

## Inventory (verified against `origin/main` @ `1bcaa5b`)

### Emission — delete

| File | What |
|---|---|
| `templates/entity/new/backend/database/schema.ejs.t` | `:13` `import { relations } from 'drizzle-orm'`; `:227-246` the `<% if (hasRelationships) %>` const block (`one`/`many` destructure, `belongsToRelations` / `hasManyRelations` / `hasOneRelations` loops); **+ `:53-58` `importedSchemas` narrowed to `belongsToRelations`** (see "Found during implementation") |
| `templates/entity/new/clean-lite-ps/entity.ejs.t` | `:15-16` the `clpHasRelationsBlock` import branch → always `import { type InferSelectModel } from 'drizzle-orm'`; `:84-98` the const block; `:8` the now-dead `.filter(i => i !== 'relations')`; **+ `:29-34` the `clpExistingHasMany` target-table import block** (see "Found during implementation") |
| `templates/junction/new/entity.ejs.t` | `:11` import → `type InferSelectModel` only; `:107-125` the const block; `:7` the dead filter |
| `templates/relationship/new/entity.ejs.t` | `:7` the dead `.filter(i => i !== 'relations')` (this template never emitted a const; the filter only existed because the import list could contain `'relations'`) |

### Gates / locals — delete

| File | What |
|---|---|
| `templates/entity/new/clean-lite-ps/prompt-extension.js` | `:648-650` `imports.add('relations')`; `:1343-1344` `hasRelationsBlock`; `:1595` `clpHasRelationsBlock` local; **+ `collectDrizzleImports`'s now-unread `hasMany` parameter and its call-site argument** (see "Found during implementation" #5) |
| `templates/entity/new/prompt.js` | `:1691` `clpHasRelationsBlock: false` default; **+ `:1484-1485` the `hasManyRelations` / `hasOneRelations` template-local exports** (see "Found during implementation" #5) |
| `templates/junction/new/prompt.js` | `:116-117` `needed.add("relations")` + its comment |

**Keep** `hasRelationships`, `belongsToRelations` (`prompt.js:849-933`, `:1488`) and `clpBelongsTo` /
`clpExistingHasMany`: they drive FK columns, indexes, `on_delete`, the CGP-358b service composition and `queries:` —
all untouched here. Before deleting any local, grep every template for other readers; delete only locals whose **sole**
reader was the const block. *Correction:* the `hasManyRelations` / `hasOneRelations` **locals inside `prompt.js` stay**
(they derive `existingHasMany`, `hasHasMany`, the index/composition values), but their **template-local exports** do
not — see "Found during implementation" #5.

### Comments — correct

- `templates/entity/new/clean-lite-ps/service.ejs.t:107` — "relations() const stays as opt-in extension" → remove the
  clause (the composition block itself stays until REL-3).

### Tests — invert, don't drop

| File | Change |
|---|---|
| `src/__tests__/clean-lite-ps/entity-fk-template.test.ts:407-414` | test "still emits the .references() FK and the relations() block" → keep the `.references()` assertion; replace the `toContain('export const messagesRelations = relations(messages')` with `not.toContain('Relations = relations(')` **and** `not.toMatch(/import \{[^}]*\brelations\b/)`. Rename the test. Fix the comment at `:356`. |
| `test/smoke/run-smoke.ts:268-380` (`relationship` scenario) | the three `/export const <x>Relations\s*=\s*relations\(/` presence assertions **and the five `one(` / `many(` const-body assertions that sit beside them** become absence assertions via a shared `assertNoV1Relations()` helper; the const-body checks are replaced by **FK `.references()` presence** assertions so the "relationships still drive the FK column" coverage is preserved rather than lost. Doc comments at `:56`, `:268-292`, `:444-448` updated. Service-composition assertions in the same function stay. |
| `test/smoke/run-smoke-junction.ts:205-209` | presence assertion → absence assertion (+ a type-only-import presence assertion). Its `assertAbsent()` helper carried a hard-coded, now-wrong failure message ("must not emit fan-out association methods — they land via #60"); generalized to the `label`. |
| `test/baseline/packages/api/src/infrastructure/persistence/drizzle/{organization,user,opportunity,deal-state,contact,deal}.schema.ts` | regenerate (`just test-baseline` update flow) — diff must be *only* the `drizzle-orm` import line, the const block, and the sibling-table imports the const was the sole reader of (Found #1) |
| `test/junction/__snapshots__/{opportunity-contact,opportunity-activity}.test.ts.snap` | regenerate — same constraint, plus the one-line `service.ejs.t` comment fix in `opportunity-contact` |

Add one guard so the slot cannot silently come back before REL-1: a unit test that greps `templates/**` for
`/\brelations\s*\(/`, `/['"]relations['"]/` **and `/import\s*\{[^}]*\brelations\b[^}]*\}\s*from/`** and expects zero hits.
The third pattern was added during implementation: neither of the first two matches a bare
`import { relations } from 'drizzle-orm'`, which is the exact form that produces TS2724 on Drizzle 1.0 — the guard as
originally specified would have missed a re-add of the import alone. Shipped as
`src/__tests__/templates/no-v1-relations-emission.test.ts`, with a sweep-non-empty assertion so a broken walk cannot
pass vacuously.

### Docs

- `docs/relationship-pattern-audit.md` §4 — dated revision note: *"2026-09: resolution Q5 ('keep `relations()` emission
  as-is') is withdrawn. Drizzle 1.0 removes the v1 API; emission deleted in DRZ-1 (#583). The slot is refilled by REL-1
  (#586) under ADR-044, which also supersedes §1's core-contract position."* Do **not** delete §1's "MUST NOT use
  `with:`" rule here — that is REL-3's change, when it becomes true.
- `docs/adrs/ADR-021-on-delete-semantics.md` — its Context (`:10`) describes the *pre-ADR* state ("generate … a
  Drizzle `relations()` helper"). It is historical context, not a current claim: leave it, no note needed.
- `docs/relationship-pattern-audit.md` §3 and §6 — also corrected (not in the original plan). §3 ("what today's
  templates actually emit") described the `relations()` emission as current state; it now carries a dated note marking
  those sub-sections historical. §6's smoke-surface table row named the presence assertion that this PR inverted; the
  row now names the absence assertion.
- `consumer-skills/entities/yaml-reference.md` §`relationships:` — also corrected (not in the original plan). It told
  consumers that `has_many` / `has_one` "drives the typed relation accessor + Drizzle `relations()`"; that is now
  false. Reworded to the service-layer composition method, which is what those declarations actually drive today.
- `CHANGELOG.md` — under the next version (0.31.0, shared with DRZ-2): "**Breaking (generated output):** the v1 Drizzle
  `relations()` const is no longer emitted (entity, clean-lite-ps entity, junction). Hand-written `db.query.*` code that
  relied on it must wait for the v2 manifest (REL-1) or declare its own."
- No version bump in this PR (DRZ-2 bumps).

## Found during implementation

Things the pre-implementation inventory missed. Each is now reflected in the tables above.

1. **The const was the sole reader of some sibling-table imports.** Deleting it left dead `import { <target> } from
   './<target>.schema'` lines in generated output.
   - `templates/entity/new/backend/database/schema.ejs.t` built `importedSchemas` from
     `[...belongsToRelations, ...hasManyRelations, ...hasOneRelations]`, but only the `belongs_to` side is referenced
     outside the const (the FK `.references()` callback at `:118/:120`). Narrowed to `belongsToRelations`. Visible in
     the baseline diff: `deal-state`, `organization` and `user` each lose an `opportunities` import.
   - `templates/entity/new/clean-lite-ps/entity.ejs.t:29-34` imported every `clpExistingHasMany` target table purely to
     feed `many(<targetPlural>)`. Deleted. `clpExistingHasMany` itself stays — `service.ejs.t` and `module.ejs.t` still
     read it for the CGP-358b composition.
   - The junction template's `leftTable` / `rightTable` imports are **not** in this class: they feed `.references()` and
     stay.

2. **The smoke's relationship assertions were broader than "three presence checks".** `assertRelationshipEmission()`
   also asserted the *contents* of the const (`parentAccount: one(accounts,`, `contacts: many(contacts)`,
   `account: one(accounts, { fields: [...] })`). Those could not simply be inverted one-for-one without losing real
   coverage, so each entity file now asserts (a) its FK column with the right `.references()` target — which is the
   thing `belongs_to` still drives — and (b) absence of the v1 surface via the shared `assertNoV1Relations()` helper.

3. **The specified guard regexes did not cover the failing form.** See the guard-test note above: a bare
   `import { relations } from 'drizzle-orm'` matches neither `/\brelations\s*\(/` nor `/['"]relations['"]/`, yet it is
   precisely the TS2724 on 1.0. A third import-shaped pattern was added, and the Acceptance grep updated to match.

4. **Docs beyond §4 made now-false current-state claims** — audit doc §3, §5, §6 and the Appendix's "Drizzle
   `relations()` emission" row, plus `consumer-skills/entities/yaml-reference.md`. All corrected (charter: specs and
   skills are living documentation). §6's assertion table now lists the assertions that actually run.

5. **Two more locals died with the const** (found by the Gate-2.5 quality review, not by the pre-implementation grep):
   `collectDrizzleImports`'s `hasMany` parameter (its only use was the deleted `imports.add('relations')` branch) and
   the `hasManyRelations` / `hasOneRelations` **template-local exports** in `prompt.js` (their only template reader was
   `schema.ejs.t`'s `importedSchemas` union + the const). Both removed. The same-named locals *inside* `prompt.js`
   stay — they still derive `existingHasMany` / `hasHasMany` / `existingHasOne` / `hasHasOne`.

6. **The first draft of the smoke's const-absence regex was vacuous** (Gate-2.5 quality blocker).
   `/\bRelations\s*=\s*relations\(/` can never match `accountsRelations = relations(accounts` — `\b` requires a
   non-word character before the capital `R`, and `s` precedes it. With `drizzle-orm@^0.45.2` still exporting
   `relations`, the smoke's `tsc` step is **not** a backstop for this, so the regex was the only guard. Fixed to
   `/\w+Relations\s*=\s*relations\(/` with a comment naming the trap. The unit test (substring `'Relations =
   relations('`) and the junction smoke (`${camelCase(plural)}Relations\s*=\s*relations\(`) were already correct.

7. **The guard earned its keep on its first run.** After the review fixes, `just test-unit` failed on the new guard —
   a code comment added in `prompt.js` spelled the deleted call literally. Harmless, but exactly the tripwire working:
   template comments may not spell the v1 call, and that constraint is now noted at the comment site.

8. **The guard test's import pattern had to run whole-file, not per line.** Every template in this repo writes import
   specifiers one per line, so a multi-line `import {\n  relations,\n} from 'drizzle-orm'` — the likeliest shape of a
   re-add — evaded a per-line scan. The import pattern now matches against the whole file and derives its line number
   from the match index; the other two stay per-line so hits stay line-reported.

## Gate results

Run after the last edit; see the PR body for the full output summary.

Gate 2.5 (paired diff review) ran before the final gate pass: **adherence → PASS_WITH_NOTES**, **quality → REVISE**
(one blocker: the vacuous const-absence regex, Found #6). The blocker and every actionable note were fixed in this PR;
the fixes are recorded in Found #4–#7 and in the tables above.

Green: `bun run build`, `bun run test`, **`just test-all`** (unit 3146/3146 · baseline · smoke · smoke-subsystems ·
smoke-relationship · smoke-junction · smoke-junction-cross-domain · junction snapshots · integration-emit ·
smoke-integration).

**Three pre-existing failures, none caused by this PR.** Each was reproduced byte-identically on a clean `origin/main`
checkout (`2b5d5ec`) before being reported here. Not filtered, not papered over (charter I9):

| Gate | Failure | Pre-existing evidence |
|---|---|---|
| `bun run typecheck` | exit 2 — four `TS2339` in `src/cli/commands/junction.ts` (×2), `src/cli/shared/barrel-generator.ts`, `src/cli/shared/jobs-path.ts` | same four errors, same exit code, on `origin/main` |
| `just test-smoke-junction-clean` | exit 1 — 21 `tsc` errors in consumer-emitted code: the `clean` junction pipeline's service / module / repository / index files import sibling paths that the emitted layout does not produce, plus unresolvable `@repo/db/server/schema` and `@mguay/nestjs-trpc` | same 21 errors on `origin/main` |
| `just test-integration` | exit 1 — `error: Script not found "codegen"`; `test/scaffold/run-integration.ts:61` still shells out to a `bun codegen` package script that no longer exists | same error on `origin/main` |

Root cause of the drift in all three: CI runs `just test-all` only (`.github/workflows/ci.yml`), and none of these three
gates is in it, so each has been red with nothing catching it. **DRZ-2 will hit the typecheck wall**, since
`bun run typecheck` is in its gate list too.

Two consequences worth recording for DRZ-2 / REL-1:

- `assertJunctionEmission()` runs at `run-smoke-junction.ts:391`, **after** the `tsc` gate at `:374`. On the `clean`
  architecture the harness exits at `tsc`, so the junction emission assertions — including this PR's inverted ones —
  have never executed for `clean`. They do execute for `clean-lite-ps` (`test-smoke-junction`,
  `test-smoke-junction-cross-domain`, both in `test-all`, both green), and both architectures render the *same*
  `templates/junction/new/entity.ejs.t`. Verified directly instead: re-running the gate with `KEEP_SMOKE_DIR=1` and
  grepping the retained `clean` tree found zero `relations(` and zero `drizzle-orm` root `relations` import across the
  whole emitted project.
- `drizzle-orm` is still `^0.45.2`, which **does** export `relations`. So no `tsc` step anywhere is a backstop against a
  v1 re-add until DRZ-2 lands — the regex assertions and the guard test are the only guard. That is why Found #6 (the
  vacuous regex) mattered.

## Out of scope

- Any `drizzle-orm` version change (DRZ-2).
- Any `defineRelations()` / v2 emission (REL-1).
- The CGP-358b service composition, constructor injection of sibling repos, the audit doc's §1 rule (REL-3).
- The smoke error filters (#576 → DRZ-2).

## Implementation order

1. Templates + prompt locals (tables above). Grep-verify no reader remains for each deleted local.
2. Unit test inversion + the new zero-hits guard test. `just test-unit`.
3. Regenerate baselines and junction snapshots; review the diff is const+import only.
4. Invert the two smoke harness assertion sets.
5. Docs (audit note, ADR-021 check, CHANGELOG).
6. Full gates, from a clean tree, after the last edit.

## Acceptance

- `grep -rnE "\brelations\s*\(|['\"]relations['\"]|import\s*\{[^}]*\brelations\b[^}]*\}\s*from" templates/` → no output.
  (The third alternative is required — the first two do not match a bare `import { relations } from 'drizzle-orm'`.)
- `bun run typecheck && bun run build && bun run test` green.
- `just test-all` green (unit · baseline · smoke · smoke-subsystems · `test-smoke-relationship` · smoke-junction ·
  smoke-junction-cross-domain · junction · integration-emit · smoke-integration), plus `just test-smoke-junction-clean`
  (the `clean` pipeline's junction path is not in `test-all`) and `just test-integration` (Docker).
- Snapshot/baseline diffs contain nothing but the removed `drizzle-orm` import, the const, the sibling-table imports
  the const was the sole reader of (Found #1), and the one `service.ejs.t` comment fix.
- Generated project still boots and serves `/docs-json` (smoke `verify-openapi.ts`).

## Risks

- **A local with a second reader gets deleted** → template render error. Mitigation: grep before each deletion; the
  baseline + three junction smokes render every pipeline.
- **`InferSelectModel` import regression in clean-lite-ps** — the import line is currently branched on
  `clpHasRelationsBlock`; collapsing it must leave exactly one `drizzle-orm` import. Covered by smoke tsc.

## Definition of done (charter §9)

Gates green from the run after the last edit (modulo the pre-existing `bun run typecheck` failure recorded above) ·
this spec corrected to what was built and marked `Implemented` · epic #579 body + log entry updated · board Status
moved.

## Open questions

None. (Resolved during implementation: the guard's regex set, and how broadly the smoke's const-body assertions could
be inverted without losing coverage — both recorded under "Found during implementation".)
