## Gate 2.5 fixes on #910: f16f1af6 and 9db2244a

| Lens / # | Sev | Outcome |
|---|---|---|
| quality B1 | **blocker** | **fixed in f16f1af6**: every cross-entity module import prints `forwardRef(() => …)`, the EAV imports included. The cycle graph that missed junctions (`moduleGraphEdges` / `reaches`) is deleted. New junction fixture (`account_contact` between a `belongs_to` pair): the junction smoke's boot gate is red with a plain import and green with the fix |
| adherence 1 | should-fix | **fixed in f16f1af6**: a new service kind `pair_delete`. A child `delete` with another kind's id pre-reads, returns without emitting and leaves the row untouched (scaffold test red before the fix). **Also fixed in 9db2244a:** `pair_update` decides by the same pre-read, so another kind's id writes nothing, emits nothing and returns `undefined` (scaffold test red before the fix) |
| quality S1 | should-fix | **fixed**: one `drizzle-orm` import set |
| quality S2 | should-fix | **fixed**: the write bodies print parameter names from the derivation (`_p[i]`) |
| quality S3 | should-fix | **fixed**: `familyConstName(entity, suffix)` in `names.ts`, with a unit test |
| quality S4 | should-fix | **pending decision**: whether the "kind with a child table only through its child" guard lives in the repository or in the service |
| quality S5 | should-fix | **pending decision**: the new write errors as HTTP 500s at S4's tip alone (S5 maps them) |
| quality S6 / adherence 5 | should-fix | **fixed**: `catalog_entry` is named in the fixture-agreement test (it exists in baseline and scaffold, and the two copies are equal) |
| adherence 2 | should-fix | **pending decision**: ratifying the two S4 scope exceptions in RFC §13.2's "must not touch" |
| adherence 3, 4 | should-fix | **fixed**: the RFC pair-write bullet (the child row is selected first); the §4.1 / §8 statement counts |
| adherence nits 6–8 | nit | **fixed**: RFC sketch drift; the `writesDisabledBy` comment; the cast-list scope |
| adherence nits 9–11 | nit | **pending decision**: OQ-14; home-module imports (now all `forwardRef`; a stale test name fixed); the changed natural-key assertion |
| quality nits 1–4, 6–8 | nit | **fixed**: the conflict read is emitted only when needed; a dead hint block deleted; required `never` / `baseCreated`; an ADR-002 revision note (dated 2026-11-15); smoke log order; a fixture path |
| quality nits 5, 9 | nit | **not fixed**: re-gating churn with no behaviour difference; a cleanup of locals across files |
| quality nit 10 | nit | **not fixed here**: the `// Inherited from` comment now also lists methods that every child and base overrides. That belongs to #893, which owns that comment; the coordinator will note it there |

Assertions that pinned plain module imports (`eav-templates`, `eav-value-table-templates`, `target-naming`) now pin the `forwardRef` form, at the same strength. Gates on the branch: typecheck clean; `test-unit` 4904 pass / 0 fail; `test-baseline` passes; `test-integration` 291 pass / 0 fail; `test-studio`, the junction smokes (6 legs), `test-smoke` and `test-smoke-capability` pass. The full `test-all` follows the cascade.
