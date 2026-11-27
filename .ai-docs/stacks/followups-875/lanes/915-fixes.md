# Lane `fu-915-fix` — #915 review fixes

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/followups-875/lanes/COMMON.md` first.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-915-barrels-invalid-yaml`
- **Branch:** `dugshub/915-barrels-invalid-yaml`, with three commits on `origin/main`. Read them first:
  `git log -p origin/main..HEAD`. The original brief is `915-build.md` in this folder.

The branch makes an invalid entity / relationship / junction YAML a named run-level rejection
(`definitionSetRejections`, `src/cli/shared/entity-render.ts`) and makes every whole-set loader throw
`InvalidDefinitionError` (`src/utils/definition-invariant.ts`) instead of skipping silently. The Opus review returned
**REVISE**: two regressions against `main`, reproduced with the CLI, on consumer paths no gate covers. The reviewer's
scratch repros are in
`/private/tmp/claude-501/-Users-dug-Projects-worktrees-codegen-patterns-dugshub-915-barrels-invalid-yaml/49cbf555-79b6-455c-a010-fede1f634f2f/scratchpad/`:
`defroot.out` (this branch), `defroot-main.out` (main), `exp1.ts`, `exp2.ts`.

Add new commits on top; this PR squash-merges. **DECIDED** items are coordinator decisions.

1. **BLOCKER — one rule for "which files are entities".** The pre-flight lists files with
   `listEntityYamls(entities, providers)` (`entity-render.ts:53`), which excludes the providers directory. Every loader
   that now throws walks the whole directory with no exclusion:
   - `barrel-generator.ts:119-129` (its own function, also named `listEntityYamls`);
   - `scope-entity-type-generator.ts:69`;
   - `event-codegen-generator.ts:289`, `:399`;
   - `relations/load-context.ts:84`;
   - `entity-registry.ts:104`, through `assertNoInvalidDefinitions`;
   - `loadEntities` with no `excludeDirs` (`frontend/load-context.ts:228`, `semantic/load-context.ts:104`).

   With the supported `paths.entities: definitions` layout (pinned by
   `src/__tests__/parser/track-d-consumer-cli.test.ts`) plus `definitions/providers/*.yaml`,
   `entity new definitions/account.yaml --dry-run --json` exits 0 on `main` and crashes uncaught on this branch. The
   default `jobs_dir` (`definitions/jobs`) sits under the same root.

   **Fix:** one owner of the entity-file listing that excludes the providers and jobs directories (and any other
   non-entity definition directory configured under the entities root — check the config schema). Every whole-set
   loader and the pre-flight use it. Delete the barrel generator's function of the same name.

   **Gate:** a CLI case with the definitions-root layout plus one provider YAML and one job YAML, where
   `entity new <valid>` (and `--all`) exits 0. Show it red on this branch before the fix.
2. **BLOCKER, DECIDED — `codegen init` must not scaffold a file its next command rejects.**
   `init-scaffold.ts:562` seeds `entities/example.yaml`, which holds comments only. Replace it with
   `entities/README.md`: a short note on how to add an entity, linking the consumer skill. It is not YAML, so no loader
   reads it. Update every smoke and harness that deletes the old placeholder (`run-smoke.ts:876`,
   `run-smoke-subsystems.ts:148`, `run-smoke-frontend.ts:182`, `run-smoke-capability.ts:630`,
   `smoke-integration/run.ts:289`, studio demo `materialize.ts:119`), and the init tests. `entity.test.ts:351` should
   pin the rejection with a truly invalid entity, not the scaffold's file.

   **Gate:** a test that runs `init` and then `entity new` on a valid entity in that fresh project, exiting 0, with no
   placeholder deletion first.
3. **`project surface` (Studio's API tab, `GET /api/surface`):** it has no pre-flight, so the invariant message ("the
   pre-flight should have stopped it") misleads there.
   - Run `definitionSetRejections` first in `project surface` and report the named rejections, in text and `--json`.
   - `loadRelationshipNames` (`derived/api/project.ts:83-89`) must classify files with `relationshipFileFailure`, not
     its own `detectYamlType` rule.
   - Test both.
4. **The remaining tolerant callers:**
   - The provider-adapter post-step (`entity.ts:851-852`, `loadEntitiesFromYaml(...).successes`) drops failures
     silently: make it throw like the other post-steps.
   - List the legitimate ones in the CLI-0 note: the pre-flight's own loads (`entity-render.ts:162`, `:249`) and the
     template parse-only lookups (`entity-naming.mjs:133`, `junction-fan-out.mjs:101`).
5. **The directory exemption** (`definition-invariant.ts:41`) is a regex on a message string. It also covers any
   readdir failure, so an unreadable directory (EACCES, ENOTDIR) reads as an empty set. Exempt only a directory that
   does not exist: check `existsSync` at the caller, or compare `issue.path === resolvedDir` together with a
   does-not-exist cause. An unreadable directory fails loudly. Add a test.
6. **DECIDED — baseline staging names its directories.** Replace `stageEntityOnlyFixtures` (`test/run-test.ts:56`,
   `:242`, `:253`), which sniffs content with `detectYamlType`, with staging **every** YAML from the two named
   directories, `ENTITY_FIXTURES_DIR` and `fixtures/integration-patterns/definitions/entities`. No sniffing; stage once.
   Output stays byte-identical.
7. **Docs:**
   - `.claude/skills/codegen/SKILL.md:53-56` still says rejected entities are skipped by default, and that schema
     failures are per-target under `--continue-on-error`. Make it match.
   - Date the CLI-0 revision note.
8. **Cleanup:**
   - Delete the dead `listRelationshipYamls` (`barrel-generator.ts:153-158`).
   - `collectRelationships` loads each file twice and has an unreachable throw (`:168`): fix both.
   - The relationships directory is spelled `path.resolve(ctx.cwd, 'relationships')` in nine places. Add
     `relationshipsDirFor(cwd)` next to `junctionsDirFor` and use it everywhere.
9. **Tests:**
   - The barrels loader case uses `toMatch(/bad|broken|broken_rel/)`, which accepts any of the three files. Make each
     iteration assert its own file.
   - Add a case for an invalid target outside the entities directory (the `extra.entities` path).

**Do not fix** the baseline harness wiping tracked `runtime/subsystems/events/generated/*` on a failed run. It
predates this PR and goes to the coordinator as its own issue.

## Gates (after your last edit; paste the tails)

`bun run typecheck`, `just test-unit`, `just test-baseline`, the whole `just test-all`, `just test-integration`.

## Report

Per COMMON.md, to `codegen-patterns-73`, as a finding → commit / test table.
