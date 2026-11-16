## Gate 2.5 fixes on #911: b86ccd41, then 1ff4e852 9f59e6dd b86ccd41 (newest first)

| Lens / # | Sev | Outcome |
|---|---|---|
| quality B1 | **blocker** | **fixed in b86ccd41**: `search.ejs.t` passes `where` only when a declared filter is set. So an unfiltered child search sorts like `GET /meetings`, and a base-column sort works. The unit test is red on the old template; new scaffold cases cover an unfiltered search, a base-column sort, empty-string filters, and `sort_by=id` with a filter |
| adherence S1 / quality S1 | should-fix | **fixed**: the delete pre-read is a derived `preRead` (from `emits:` containing `<entity>_deleted`), printed by the delete template and Studio. Its compile path runs in the smoke: the smoke-only `crate` child emits `crate_deleted`, the smoke installs the events subsystem, and one shared `composeSubsystemModules` helper (`test/smoke/_compose-subsystems.ts`) wires `SUBSYSTEM_MODULES` for both smokes. Nothing generated from the baseline (which ships under `runtime/`) changes |
| quality S1 (extras) | should-fix | **partly fixed**: delete reads the named `preRead`. The list template's child-rooted branch still prints `service.list` / `count` literally, as the RFC now says; extending the parity gate to use-case refs is a follow-up |
| adherence S2 | should-fix | **fixed**: RFC drift (§4.1 route, §6 `listKind` `childWith`, §13.1 children, §5 sample) and the fixture headers |
| quality S2 | should-fix | **pending decision**: `kind_requires_child` / `createPath` cannot reach HTTP, because the DTO refuses `kind` first |
| quality S3 | should-fix | **fixed**: `output.ejs.t` / `create.ejs.t` render the DTO body once |
| quality S4 | should-fix | **fixed**: `dtoSchemaNames` / `dtoFileStem` in `src/derived/api/names.ts` are the one owner |
| quality S5 / adherence nit 1 | should-fix | **fixed**: the child search controller returns `<Child>Flat` |
| quality S6 / adherence nit 4 | should-fix | **fixed**: `sort_by=id` with a filter is the child's column when a `where` applies |
| quality nits 1–3, 5–7, 10; adherence nits 2, 3, 5 | nit | **fixed**: cast narrowed; `_kindGuarded` computed once; `verify-openapi` positive controls; JSDoc; stems; orphan handling documented; whole error bodies asserted with `toEqual` |
| quality nit 4 | nit | **pending decision**: restoring the removed Studio `origin.text` assertions |
| quality nit 8 | nit | **not fixed**: the unrouted `OfKind` / `Create<Base>Dto` schemas are kept for programmatic callers (RFC); routing them is a decision |
| adherence nit 6 (OQ-5 row) | nit | **pending decision**: "kind key" vs "relation key" in §11.1 |

Gates on the branch: typecheck clean; `test-unit` 4929 pass / 0 fail; `test-baseline` passes with a clean tree; `test-smoke` and `test-smoke-subsystems` pass; `test-integration` 315 pass / 0 fail; `test-studio` passes. The full `test-all` follows the cascade.
