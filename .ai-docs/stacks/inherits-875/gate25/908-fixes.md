## Gate 2.5 fixes on #908: bb3baf60 (code) and fb5c5b9c (docs and tests)

| Lens / # | Sev | Outcome |
|---|---|---|
| adherence 1 | should-fix | **fixed in bb3baf60**: a self-targeting `match:` onto the entity's own enum no longer imports the enum twice; `relativeModuleDir` returns `.` for the same folder. Two tests, red before and green after |
| adherence 2 | should-fix | **pending decision**: whether a derived `match:` column should be read-only in the output DTO. The RFC's "Not done" bullet now says it is absent there |
| adherence 3 | should-fix | **fixed in fb5c5b9c**: S2 closes "A5 (rejections)"; S4 closes the rest of A5 (the insert fills the column) |
| adherence 4 | should-fix | **fixed in fb5c5b9c**: the RFC describes the fixture-agreement test's resolved-tenancy comparison |
| quality 1 | should-fix | **fixed in bb3baf60**: counterpart rejection runs to a fixpoint, so the children of a rejected base are rejected too. Test: with `emits:` broken on the base, no child is written (red before) |
| quality 2 | should-fix | **pending decision**: Drizzle's default `.references()` names and the junction / relationship constraint names are not length-checked, and the fixture family emits 78- and 70-byte FK names. Without a decision, the minimum is in fb5c5b9c: the code comment, the test header and the RFC now claim only "names the extra-config callback declares", and list what is not covered. The issue gets filed |
| quality 3 | should-fix | **fixed in bb3baf60**: the docs give the real re-render reasons (the child imports the base's table and `.enums`, and a rejected base rejects the child) |
| adherence nits 5–12 | nit | **fixed in fb5c5b9c / bb3baf60**: RFC narrowing and naming; owners of `matchPairsOf` / `inheritanceCounterpartNames`; an unreachable throw deleted; test citations |
| quality nits 4–6, 9, 11–13 | nit | **fixed**: an unreachable branch deleted; message wording; `matchReferrers` throws with no lookup (new test); stale headers; the exact family count in the runtime-load gate; the RFC S6 list |
| quality nit 7 | nit | **not fixed**: refactoring the constraint block risks regenerating bytes; it is better as its own change |
| quality nit 8 | nit | **not fixed**: a single Postgres identifier-limit constant goes with quality 2's decision |
| quality nit 10 | nit | **not fixed**: restructuring the fixture copies is optional; the agreement test guards them |

Gates on the branch: typecheck clean; `test-unit` 4816 pass / 0 fail; `test-baseline` passes. The full `test-all` and `test-integration` run follows the cascade.
