# S4 phase R2 light-review fixes — lane `inh-r2s4-fix`

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/lanes/COMMON.md` first. Branch
`dugshub/875-s4-inherits-writes`, worktree `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-875-s4-inherits-writes`.
One new commit on top of a60af64e (squash-merged stack; no history rewrite). **DECIDED** items are coordinator
decisions. **Gate for every item: `test/baseline` and `test/render-golden/**` stay byte-unchanged** unless a finding
says otherwise.

1. **DECIDED — one kind per body.** Today `repository.ejs.t:715,758` and `service.ejs.t:257` pick the `pair_write`
   body by `m.name === 'create'/'update'` (ADR-046:118: no template branches on a method name), and the upsert body is
   inferred (`_upsert = _hasUpsert && !_child`, `_child` = "a with_base entry exists"), replacing phase R's
   derivation-owned `'own' | 'through_base'`. Split, as kinds (not a variant field), following S3's `across_kinds`
   split:
   - `types.ts` repository kinds: `pair_write` → `pair_create | pair_update | pair_delete`; `upsert` →
     `upsert_own | upsert_through_base`. Service kinds: `pair_write` → `pair_create | pair_update`; `upsert` →
     `upsert_own | upsert_through_base`. `kind_guard` stays.
   - `entity.ts:446-472` / `581-608`: push the split kinds (`kind: writeFamily.upsert === 'own' ? 'upsert_own' :
     'upsert_through_base'`).
   - Templates: a `_PAIR` list like `_ACROSS`; `_upsert` / `_childUpsert` from `m.kind`; drop the `_child` inference.
   - Print `<%= m.name %>` and `m.params[i].name` in the nine signatures that hard-code create / update / delete /
     upsertByNaturalKey / id / patch / input / tx (repo `:735,767,803,822,837,880`; service `:266,271,288,294,305`), as
     every Phase B branch does.
   - Studio rows (`surface-kinds.ts`; `Record<Kind>` makes a missing row a tsc error), the surface-view test, golden
     `kind` values, `family-reads.test.ts`.
2. **DECIDED — module imports have one owner.** `module.ejs.t:27-29,78-81` print `familyChild.baseModuleClass` (from
   `inheritance.mjs:340-341`) beside `repositoryDepModules` (`:31-33,82-88`), never deduped, and the base import never
   gets `forwardRef`. A child with a `belongs_to` / `has_many` to its own base imports the base module twice (TS2300);
   a base with a `belongs_to` to one of its children is a cycle whose child side lacks `forwardRef`. Fix: in
   `entity-locals.js`, put the base **first** in `repositoryDepModules`, deduped by entity, with
   `forwardRef: reaches(base, entityName)` (the existing `moduleGraphEdges` reachability) and an `inherits: true` flag the
   template uses only to print its comment line (keeps bytes); delete `baseModuleClass` / `baseModuleImportPath` and the
   `familyChild` blocks in `module.ejs.t`. **Gate:** add both scenarios (a child with a relation to its own base; a base
   with a `belongs_to` to a child) to a fixture set that `tsc` compiles (the smoke fixtures are fine), and show the
   first red (TS2300) before the fix. Correct RFC `:1546`.
3. `entity.ts:201-203`: the comment says `entity-locals.js` reads `familyWriteSurface` for flags — its readers are the
   derivation and `family-reads.test.ts`.
4. RFC-0006 S4 R2 bullet (`:1600-1611`): rewrite the `pair_write` / upsert clauses to the new kinds (no "by `m.name`");
   "every `*.module.ts` in the matrix" → 29 of 30 (`matrix-self-fk/categories.module.ts` correctly unchanged); 13
   matrix cases, not 14.
5. `service.ejs.t:24` builds a second `_EU = entityName.toUpperCase().replace(…)` beside S3's `repository.ejs.t:38` —
   two derivations of the cross-file `<EU>_BASE_KEYS` name. Give entity-locals one keyed local (the constant names the
   two templates share) and read it from both; bytes unchanged.

Gates after your last edit (paste tails): `bun run typecheck`, `just test-unit`, `just test-baseline`,
`just test-smoke`, `just test-studio`. Report with `SendMessage` to `codegen-patterns-73` (hc terminal `t1rf`), then stop.
