# R4 light-review fixes — lane `inh-r4`

Light review of S4 phase R (609f2fd7 + the rebase resolution in 4a7e5078): ACCEPT_WITH_FIXES. HEAD is correct;
the should-fix is history. COMMON.md binds you.

1. **The rebased commits do not render on their own.** At 4a7e5078 / 4ab8f1dd / 6945a924: (a) `entity-locals.js`
   calls `inheritsOf` with no import (S3's resolution dropped S4's `import { inheritsOf, matchPairsOf }`), and from
   4ab8f1dd it runs in `moduleGraphEdges` over every document, so every `entity new` throws; (b)
   `templates/_shared/inheritance.mjs:327,341` call `pascalCase`, which S3's phase R deleted. Both are repaired only
   inside 609f2fd7. **Fold each repair into the commit that broke it:** make a fixup for 4a7e5078 carrying the
   `inheritsOf` import and the `pascalCase` → `entityClassName` / `repositoryClassName` calls, then
   `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash dugshub/875-s3-inherits-reads` (the phase R commit then no
   longer carries those repairs). Prove it: check out each S4 commit in turn (a detached scratch worktree is fine)
   and run `bun run typecheck` plus `just test-baseline` on the first one — it must pass. Fold the two separate
   imports from `src/schema/inheritance.js` in `entity-locals.js` (`:31`, `:51`) into one while you are there.
2. `src/parser/load-entities.ts:141` still reads `natural_key === true` into `ParsedEntity.naturalKey`, which
   nothing reads — delete the dead field (it contradicts "the ONE reader of the marker"); the R11 validator stays a
   legitimate second reader.
4. Put the new shape under tsc: add a family whose base declares **no** `natural_key` to the smoke fixtures
   (`test/smoke/fixtures/`; generic names; keep the fixture-agreement test green), so the "no upsert on that child"
   change is compiled, not only existence-checked.
5. One owner for the module-class name: add `moduleClassName(plural)` to `src/derived/api/names.ts` and use it at
   `inheritance.mjs:341`, `entity-locals.js:2704` and `:2100` (byte-identical output expected; if a byte changes,
   stop and report).
6. The upsert origin note (`entity.ts:456`) names the base: `"<base>'s natural key, through <child>'s inherits"`;
   update the golden and the Studio test.

Gates after your last edit (paste tails): `bun run typecheck`, `just test-unit`, `just test-baseline`,
`just test-smoke`. Report to `codegen-patterns-73` with the per-commit check from item 1, then stop.
