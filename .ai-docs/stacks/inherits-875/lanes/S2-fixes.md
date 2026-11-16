# S2 review fixes — lane `inh-s2-build`

The Opus review of `dugshub/875-s2-inherits-ddl` @ `173c85b0` returned **REVISE**: gates green, but four
correctness bugs reproduced in scratch projects (the reviewer's repro projects are under
`/private/tmp/claude-501/-Users-dug-Projects-worktrees-codegen-patterns-dugshub-875-s2-inherits-ddl/dccd4b26-c2b7-4b3d-bab7-766db8ce1155/scratchpad`
— `p-literal`, `p-tenantmatch`, `p-roles`, `p-m3null`). Fix on the same branch as new commits (no history rewrite);
COMMON.md still binds you. Re-verify each finding before fixing it, and add a test for each correctness fix that
fails without the fix. **Coordinator decisions are marked DECIDED** — do them as stated.

## Correctness

1. **`tCols` by regex rewrites user SQL** (`entity-locals.js:2432`, `c.expr.replace(/\bt\./g, 'tCols.')`). A partial
   index `where: "note <> 'https://t.co'"` on a match referrer emits `'https://tCols.co'`. **DECIDED:** delete the
   regex. **One** callback parameter name for **every** table (keep `tCols` — camelCase, so no plural can match it),
   passed into every builder that writes a column reference (`onCols` `:1102`, the index sites, `fkExpr`, the
   uniques, `check`, and `renderSqlPredicate`, which hardcodes `${t.…}`). This changes the callback parameter in every
   existing entity snapshot; that is accepted. Put it in **its own commit** (mechanical rename + re-blessed
   baselines) so it reviews on its own, and say in the commit body why. Test: the `'https://t.co'` literal survives.
2. **Eager enum import → boot-time TDZ crash.** S2 made the first eager cross-entity value import (an imported
   `pgEnum` called at module top level). With `communication.organizer: belongs_to communication_participant`
   (nullable), loading the entity files throws `ReferenceError: Cannot access 'communicationKindEnum' before
   initialization`. **DECIDED:** every entity that declares a `pgEnum` emits its enums into a leaf module that
   imports nothing but `drizzle-orm/pg-core` — one rule for every entity, not only family members. Name the file
   through `emittedStem` (e.g. `<entity>.enums.ts` beside `<entity>.entity.ts`); the entity file imports from it and
   re-exports its enums so the schema barrel / drizzle-kit still see them; every cross-entity enum import (child
   `kind`, `choices_of:`, `match:`) points at the owner's leaf module. Own commit, re-blessed baselines. **Gate:** add
   a test that actually **loads** generated entity modules with a base → child / base → match-referrer cycle (the
   reviewer's repro shape) and fails on the TDZ error — tsc cannot catch this, so the test must import at runtime.
   Show it red before the fix.
3. **A derived `match:` column takes nullability from the first matching FK** (`inheritance.mjs:288`). Declaring a
   nullable `role` before the NOT NULL `communication` leaves `communication_kind` nullable, and Postgres' MATCH
   SIMPLE then skips both composite FKs on a NULL. Fix: the derived column is NOT NULL if **any** matching FK is NOT
   NULL. **DECIDED** for the RFC gap: when every matching FK is nullable, emit an internal CHECK
   `(<fk> IS NULL) = (<derived> IS NULL)` per FK (through the internal check builder), so a set FK with a NULL derived
   column cannot skip the check; record the rule in RFC §2.4. Integration case: a nullable-match row with the FK set
   and the derived column NULL is refused.
4. **Counterparts skip `emits:` / `roles:` validation** (`entity-render.ts:233` vs `:114`). `entity new meeting.yaml`
   with a bad `roles:` on `communication` writes meeting's files, then hygen crashes on the base — a half run. Fix:
   append counterparts before `emitsTargetEntities` is computed; test the clean refusal with nothing written.
5. **The base's `unique(id, tenant)` is outside the dedupe set** (`entity-locals.js:2341/2354`). A
   `match: { comm_tenant_id: tenant_id }` onto the base passes validation, then generation fails on a duplicate
   constraint name. Fix: add the tenant column set to `inheritanceFor`'s `sets` map; test it generates one unique.

## Gates and tests

6. **Fixture agreement deletes `tenant_scoped`** (`inheritance-fixtures-agree.test.ts:44`) — a copy that drops
   tenant scoping would still compare equal. Fix: compare `resolveTenancy(...)?.column` against each location's own
   project tenancy column instead of deleting the key. Show it red when one copy drops `tenant_scoped`.
7. **63-byte names:** move the check into `assertDistinctConstraints` so **every** emitted constraint/index name
   passes through it (including S2's `<table>_<tenant>_idx` and pre-S2 names); the message names `entity.table:`
   (TABLE-0) as the escape hatch; add a unit test. If an existing baseline name exceeds 63 bytes, stop and report.

## One owner

8. The `match:` shorthand normaliser exists twice (`inheritance.mjs:43 matchPairsOf` and `load-entities.ts:181-185`),
   and family / referrer discovery is coded over ParsedEntity (`inheritanceCounterparts`) and again over raw docs
   (`matchReferrers` / `inheritanceFor`). Move the normaliser (and, if the shapes allow, the discovery) into
   `src/schema/inheritance.ts` next to `inheritsOf` and use it from both sides (check `package.json` `files` for the
   template-src-imports gate). `lookup.definitions()` on a blocks-only lookup returns `[]` (`entity-naming.mjs:71`) —
   make it strict like `definition()`.

## Docs and nits

9. `validate-inheritance.ts:532` and RFC `:1222` claim "a base's own render already reads its children" — false; a
   base's output depends only on its own YAML and its match referrers. Correct both, and say that editing a base and
   rendering only the base leaves its children stale, as `belongs_to` does today.
10. RFC: record that until S3 a child's reads are unscoped (`tableScope(schema.meetings, UNSCOPED)`, charter I3) and
    that S2 must not land without S3 (the stack lands atomically); record for S6 that the frontend emitter does not
    read `generate.writes`, so a child would get mutations aimed at routes that do not exist until S4/S5.
11. Nits: unused `tableName` (`inheritance.mjs:190`), `baseTableName` (`:223`) and the phantom `declaredColumns`
    JSDoc param; hoist the re-derived `?? DEFAULT_CODEGEN_CONFIG` (`entity-locals.js:2167` vs `:1701`, `:1963`); move
    the `as:` "plain identifier" refusal from generation into S1's validation; one import order for
    `communicationKindEnum, communications`; update the DDL samples in RFC §2.1 / §2.4 to the emitted shape
    (`tCols`, the leaf enum module, `communication_participant_roles`); the fixture relationship `person` with FK
    `person_id` targeting `party` — rename it to `party` / `party_id` in every fixture copy.

## Gates after your last edit (paste tails)

`bun run typecheck`, `just test-unit`, `just test-baseline` (pre-existing snapshot changes now expected: the callback
rename and the enum leaf modules — list the categories, nothing else), `just test-smoke`, `just test-integration`,
`just test-smoke-frontend`, `just test-smoke-junction`, `just test-smoke-relationship` (the enum move reaches every
generator). Report per COMMON.md with a finding → commit / test table.
