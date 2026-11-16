## Gate 2.5 fixes on #909: all in c455d1c6

| Lens / # | Sev | Outcome |
|---|---|---|
| adherence 1 | should-fix | **fixed**: the `includes` bullet names `hasTypedInclude` as the owner and says S3 opens `api.includes` for family members |
| adherence 2 | should-fix | **fixed**: `message_communication_part` is in §13.1, §7 and the three fixture comments. **Pending decision:** whether S4/S5 need a base-only kind on the soft-delete family |
| quality 1 | should-fix | **fixed**: `familyRelationKey` in `src/schema/inheritance.ts` is the one owner for `build-graph.ts` and `familyReads`. New test: red with the old call (`comm2` vs `comm_2`) |
| quality 2 | should-fix | **fixed**: the family reads are projections over the READ-1 reads. `findWithBase` → `findById`, `findManyWithBase` → `findByIds`, `findAllKinds` / `listKind` → `list`, `findKindById` → `findById`; only `findOrphans` keeps its own read. The `no-unscoped-db-query` site count drops from 12 to 7. The statement counts still pass against Postgres |
| quality 3 | should-fix | **fixed**: a `user_tracking` base is covered. `scope-filters.spec.ts` tests the base user guard inside the `EXISTS` (bound param, strict throw, lenient / superuser), and `inherits-graph.test.ts` tests the manifest literal. Red when the child table is passed |
| adherence nits 3–7, 9 | nit | **fixed**: RFC scope and §10 row 11; the `hasTypedInclude` role case; A9's gates; the null-hop limit under `softDelete: false`; the §8 cost table; a dated REL-2 revision line |
| adherence nit 8 / quality nit 9 | nit | **pending decision**: the `_EU` / `_eLower` helper names, and whether to widen the no-name-derivation lint |
| quality nits 4, 6–8, 10, 11 | nit | **fixed**: `familyChildren` read once; one `drizzle-orm` import; a docstring; a base relation key in `with` is now a type error (`@ts-expect-error` gate); the `baseScope` clause prints only when there is a base scope |
| quality nit 5 | nit | **not fixed**: carrying the read-kind grouping on the derived method would change the api-surface goldens, and the parity gate already catches a missed kind |

Gates on the branch: typecheck clean; `test-unit` 4866 pass / 0 fail; `test-baseline` passes; `test-integration` 250 pass / 0 fail. The full `test-all` follows the cascade.
