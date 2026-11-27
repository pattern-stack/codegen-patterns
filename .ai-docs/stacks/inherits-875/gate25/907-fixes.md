## Gate 2.5 fixes on #907: all in b5323f64

| Lens / # | Sev | Outcome |
|---|---|---|
| adherence 1 | should-fix | **fixed**: `activityColumnsRead` includes `user_id`; new R6 test; RFC as-built corrected |
| adherence 2 | should-fix | **fixed**: `MetadataPattern.columnsRead` = `entity_id`, `entity_type`, `valid_from`; new R6 test; RFC §1.3 reworded |
| adherence 3 | nit | **fixed**: the R6 test uses a base column that is not a column read |
| adherence 4 | nit | **fixed**: `eav_value_table` is recorded in §8 as a child-only refusal, and the "(R9)" label is dropped |
| adherence 5 | nit | **fixed**: stale comments corrected; unused `declaresColumn` removed |
| adherence 6 | nit | **fixed**: RFC §10 and §1.2 point at `src/schema/inheritance.ts` + `validate-inheritance.ts`; PR body updated |
| adherence 7 / quality 3 | should-fix | **fixed**: `analyzeDomain` resolves the sync mode; the validator's `tenancyColumn` / `syncMode` are required, with no default |
| adherence 8 / quality nit 9 | nit | **fixed**: the positive CLI case asserts that `schema.ts` and `relations.ts` exist |
| quality 1 | should-fix | **partly fixed**: `user_id`, Metadata `columnsRead`, and R6 parses through the pattern's `configSchema` with no cast. **Pending decision:** failing closed on a pattern with no `columnsRead` (it reverses an as-built note; the RFC marks it pending). A shared Activity-defaults helper needs `runtime/`, which S1 must not touch: deferred |
| quality 2 | should-fix | **fixed**: both `declaredPatternNames` copies deleted; imports come from `src/patterns/compose.js` |
| quality 4 | should-fix | **fixed**: `implicitColumns` includes `PatternDefinition.columns`; new probe-pattern test. A single shared column-origin helper across composition, tenancy and the validator is a cross-module refactor: not done |
| quality nits 1, 3, 5, 6, 8 | nit | **fixed** (dead code; stale comments; the R10 mislabel; a type escape; weak test helpers, and the R2 base-only test now exercises R2) |
| quality nit 2 | nit | **fixed** by the header rewrite (the two lookups stay separate on purpose) |
| quality nit 4 | nit | **partly fixed**: the R5 message renders from the constant; moving placement onto each `BehaviorDefinition` is a refactor outside this PR |
| quality nits 7, 10 | nit | **not fixed**: a shared `order:` parser needs a schema-layer move across 4 copies; the regex copies have no behaviour effect |

Gates on the branch: typecheck clean; `test-unit` 4771 pass / 0 fail; `test-baseline` passes. The full `test-all` and `test-integration` run follows the cascade.
