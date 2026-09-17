# DRZ-1 — Drop v1 `relations()` const emission

**Status:** Draft
**Date:** 2026-09-17
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
| `templates/entity/new/backend/database/schema.ejs.t` | `:13` `import { relations } from 'drizzle-orm'`; `:227-246` the `<% if (hasRelationships) %>` const block (`one`/`many` destructure, `belongsToRelations` / `hasManyRelations` / `hasOneRelations` loops) |
| `templates/entity/new/clean-lite-ps/entity.ejs.t` | `:15-16` the `clpHasRelationsBlock` import branch → always `import { type InferSelectModel } from 'drizzle-orm'`; `:84-98` the const block; `:8` the now-dead `.filter(i => i !== 'relations')` |
| `templates/junction/new/entity.ejs.t` | `:11` import → `type InferSelectModel` only; `:107-125` the const block; `:7` the dead filter |
| `templates/relationship/new/entity.ejs.t` | `:7` the dead `.filter(i => i !== 'relations')` (this template never emitted a const; the filter only existed because the import list could contain `'relations'`) |

### Gates / locals — delete

| File | What |
|---|---|
| `templates/entity/new/clean-lite-ps/prompt-extension.js` | `:648-650` `imports.add('relations')`; `:1343-1344` `hasRelationsBlock`; `:1595` `clpHasRelationsBlock` local |
| `templates/entity/new/prompt.js` | `:1691` `clpHasRelationsBlock: false` default |
| `templates/junction/new/prompt.js` | `:116-117` `needed.add("relations")` + its comment |

**Keep** `hasRelationships`, `belongsToRelations`, `hasManyRelations`, `hasOneRelations` (`prompt.js:849-933`, `:1488`)
and `clpBelongsTo` / `clpExistingHasMany`: they drive FK columns, indexes, `on_delete`, the CGP-358b service
composition and `queries:` — all untouched here. Before deleting any local, grep every template for other readers;
delete only locals whose **sole** reader was the const block.

### Comments — correct

- `templates/entity/new/clean-lite-ps/service.ejs.t:107` — "relations() const stays as opt-in extension" → remove the
  clause (the composition block itself stays until REL-3).

### Tests — invert, don't drop

| File | Change |
|---|---|
| `src/__tests__/clean-lite-ps/entity-fk-template.test.ts:407-414` | test "still emits the .references() FK and the relations() block" → keep the `.references()` assertion; replace the `toContain('export const messagesRelations = relations(messages')` with `not.toContain('Relations = relations(')` **and** `not.toMatch(/import \{[^}]*\brelations\b/)`. Rename the test. Fix the comment at `:356`. |
| `test/smoke/run-smoke.ts:268-380` (`relationship` scenario) | the three `/export const <x>Relations\s*=\s*relations\(/` presence assertions (`:311`, `:350`, `:372`) become absence assertions; update the doc comments at `:56`, `:268-292`, `:444-448`. Service-composition assertions in the same function stay. |
| `test/smoke/run-smoke-junction.ts:205-209` | presence assertion → absence assertion |
| `test/baseline/packages/api/src/infrastructure/persistence/drizzle/{organization,user,opportunity,deal-state,contact,deal}.schema.ts` | regenerate (`just test-baseline` update flow) — diff must be *only* the import line + const block |
| `test/junction/__snapshots__/{opportunity-contact,opportunity-activity}.test.ts.snap` | regenerate — same constraint |

Add one guard so the slot cannot silently come back before REL-1: a unit test that greps `templates/**` for
`/\brelations\(/` and `/['"]relations['"]/` and expects zero hits.

### Docs

- `docs/relationship-pattern-audit.md` §4 — dated revision note: *"2026-09: resolution Q5 ('keep `relations()` emission
  as-is') is withdrawn. Drizzle 1.0 removes the v1 API; emission deleted in DRZ-1 (#583). The slot is refilled by REL-1
  (#586) under ADR-044, which also supersedes §1's core-contract position."* Do **not** delete §1's "MUST NOT use
  `with:`" rule here — that is REL-3's change, when it becomes true.
- `docs/adrs/ADR-021-on-delete-semantics.md` — its Context (`:10`) describes the *pre-ADR* state ("generate … a
  Drizzle `relations()` helper"). It is historical context, not a current claim: leave it, no note needed.
- `CHANGELOG.md` — under the next version (0.31.0, shared with DRZ-2): "**Breaking (generated output):** the v1 Drizzle
  `relations()` const is no longer emitted (entity, clean-lite-ps entity, junction). Hand-written `db.query.*` code that
  relied on it must wait for the v2 manifest (REL-1) or declare its own."
- No version bump in this PR (DRZ-2 bumps).

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

- `grep -rnE "\brelations\(|['\"]relations['\"]" templates/` → no output.
- `bun run typecheck && bun run build && bun run test` green.
- `just test-all` green (unit · baseline · smoke · smoke-subsystems · `test-smoke-relationship` · smoke-junction ·
  smoke-junction-cross-domain · junction · integration-emit · smoke-integration), plus `just test-smoke-junction-clean`
  (the `clean` pipeline's junction path is not in `test-all`) and `just test-integration` (Docker).
- Snapshot/baseline diffs contain nothing but the removed import and const.
- Generated project still boots and serves `/docs-json` (smoke `verify-openapi.ts`).

## Risks

- **A local with a second reader gets deleted** → template render error. Mitigation: grep before each deletion; the
  baseline + three junction smokes render every pipeline.
- **`InferSelectModel` import regression in clean-lite-ps** — the import line is currently branched on
  `clpHasRelationsBlock`; collapsing it must leave exactly one `drizzle-orm` import. Covered by smoke tsc.

## Definition of done (charter §9)

Gates green from the run after the last edit · this spec corrected to what was built and marked
`Implemented` · epic #579 body + log entry updated · board Status moved.

## Open questions

None.
