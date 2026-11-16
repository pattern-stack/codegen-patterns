# Lane `fu-915-fix2` — #915 second re-review fixes

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/followups-875/lanes/COMMON.md` first.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-915-barrels-invalid-yaml`
- **Branch:** `dugshub/915-barrels-invalid-yaml`.
- **Read first:** `git log -p origin/main..HEAD`, plus `915-build.md` and `915-fixes.md` in this folder.

The re-review returned **ACCEPT_WITH_FIXES**. The blocker is fixed and gated, but "one rule for which files are
entities" is only partly true. Fix everything below in **one new commit** (the PR squash-merges). **DECIDED** items are
coordinator decisions.

1. **F1 + F3 — every listing goes through `listEntityYamls(dir, nonEntityDirs)`, and `nonEntityDirs` is required.**
   Several callers still walk the entities directory by themselves, with an optional exclusion:
   - `loadEntities(entitiesDir, { tablePrefix })` (`load-entities.ts:331` / `:344`; `excludeDirs?`);
   - `loadEntityRegistry` (`entity-registry.ts:96` / `:106`; `nonEntityDirs?`);
   - `loadEntityDefinitions(entitiesDir, nonEntityDirs = [])` (`emitters/relations/load-context.ts:82`);
   - `analyzeDomain` (`src/index.ts:63`) and `validateEntities` (`:168`).

   These feed `entity validate` (Studio's `/api/validate`), `project inspect --kind analyze|stats|doc|manifest|suggestions`
   and `project graph` (the Studio canvas). In the definitions-root project (`paths.entities: definitions` plus a
   provider YAML and a job YAML), `entity validate --json` and `project inspect --kind analyze --json` both exit 1,
   rejecting the job and the provider as entities, while `entity new` exits 0.

   Fix: all of them take a **required** `nonEntityDirs` (no default, no `?`) and list through `listEntityYamls`. Every
   caller passes `projectLayout(...).nonEntityDirs`. Find every caller, including tests.
2. **F2 — Studio.**
   - `src/studio/server/files.ts:101`: `listFiles` keeps its own exclusion list, which has no jobs and no events
     directory. Use `listEntityYamls(dirs.entities, layout.nonEntityDirs)`.
   - `kindForPath` (`:124-138`) must return null for any path under a non-entity dir, so a job file is not validated
     against `EntityDefinitionSchema`.
   - Test both with the definitions-root layout.
3. **F4 — gate legs.** The current gate stays green after these mutations:
   - dropping `excludeDirs` from `frontend/load-context.ts:230` or `semantic/load-context.ts:106`;
   - dropping `events_dir` from `nonEntityDirs`.

   Extend the definitions-root fixture:
   - `paths.events_dir: definitions/events`, plus one event YAML;
   - a `generate.frontend: true` leg, or direct calls to `loadFrontendEmitContext` and `loadSemanticEmitContext` on the
     fixture;
   - legs for `entity validate` and `project inspect --kind analyze`, covering F1.

   Show each new leg red against its mutation, then green.
4. **F5, DECIDED — one relationships directory.** `project graph` (`project.ts:856-862`) tries
   `dirname(entities)/relationships` and `<entities>/relationships` before `relationshipsDirFor(cwd)`, while
   `entity new`, the pre-flight, the barrels and `project surface` read only `relationshipsDirFor(cwd)`. Delete the two
   extra candidates so the canvas and the generator see the same relationships. If `project graph <dir>` with an
   explicit dir argument needs a lookup beside that dir, keep it only on that path, and say so. Test that a
   relationship outside `relationshipsDirFor(cwd)` is not drawn. Record the behaviour change in the CLI-0 note.
5. **F6 — docs.** The CLI-0 "One rule" paragraph: make "every whole-set loader uses it" true. List the remaining
   walks:
   - `templates/entity/new/prompt.js:183-215` (`loadOwnedTableNames`), which is parse-only;
   - `src/analyzer/manifest.ts:58-80` (`computeEntityFilesHash`): make it use `listEntityYamls` too, or justify the
     exception.
6. **F7 — nits.**
   - The orphaned `outputPath` JSDoc in `scope-entity-type-generator.ts:34-36`.
   - The copied header in `entity-definitions-root.test.ts:1-8`.
   - `regeneration-failure.test.ts:82` / `:198` still write `example.yaml`: rename to `note.yaml`.
   - `ai-docs/specs/cli-02-entity-noun.md:67` and `ai-docs/specs/issue-120-entity-all-continue-on-error.md:14` need
     dated revision lines.
   - Drop the `config as Parameters<typeof projectLayout>[1]` casts in the three load-contexts, if a typed path
     exists.

## Gates (after your last edit; paste the tails)

`bun run typecheck`, `just test-unit`, `just test-baseline`, the whole `just test-all`, `just test-integration`,
`just test-studio`.

## Report

Per COMMON.md, to `codegen-patterns-73`, as a finding → test table.
