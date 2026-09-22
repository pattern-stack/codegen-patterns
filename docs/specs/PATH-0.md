# PATH-0 — one default per `paths.*` key; every reader and every scaffold goes through it

**Status:** Implemented
**Date:** 2026-09-18 · **Implemented:** 2026-09-18
**Issues:** #642 (readers' fallbacks disagree) · #566 (init + subsystem scaffolds ignore `paths.backend_src` /
`paths.entities`) · #612 (emitted `app.module.ts` / root `schema.ts` hard-code `./generated`)
**Project:** #578
**Depends on:** CFG-0 (#640, #644): one strict schema, one loader
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Operating
Principles (no backwards compatibility)

## Why

CFG-0 made `codegen.config.yaml` one parsed object, but each reader still picks its own fallback for an absent key.
The same config therefore resolves to different directories depending on the reader: `paths.backend_src` is `src`
in the CLI and `app/backend/src` in `paths.mjs` / `locations.mjs`. `project init`, every `subsystem install` scaffold
and the files init emits ignore `paths.*` completely and write to `<cwd>/src/…`, `<cwd>/entities/`, and `./generated/…`.

## Charter invariants this PR touches

- **I1 declare once.** Every `paths.*` default is declared once, in `PathsConfigSchema`. The four keys that default
  relative to `backend_src` are derived in the same schema, by one transform. Every reader gets the resolved value, so
  none of them carries a literal.
- **I7 no backwards compatibility.** Fallback chains collapse to the one resolved value. `entities` no longer
  falls back to `<cwd>/entities`, and subsystem detection no longer probes three roots. The `app/backend/src` default
  and the dead `paths.mjs` exports that carried a second `frontend_src` default are deleted.
- **I9 gates are honest.** A new smoke leg compiles a project whose every path is non-default, in both runtime modes.
- **I11 scope.** Generator plumbing and the files `project init` / `subsystem install` emit. Default-path output is
  byte-identical: baseline, junction snapshots and every existing smoke are unchanged.

## Design

### The defaults table

`PathsConfigSchema` (`src/schema/codegen-config.schema.ts`) declares a `.default()` for each static key. The derived
keys stay `.optional()` in the object, and `ResolvedPathsSchema = PathsConfigSchema.transform(resolvePathDefaults)`
fills them in from the resolved `backend_src`. `CodegenConfigSchema.paths` is `ResolvedPathsSchema.default({})`, so
`config.paths.<key>` is always a string after the parse. With no config file, readers use `DEFAULT_CODEGEN_CONFIG`
(`CodegenConfigSchema.parse({})`, exported by `project-config.ts`). Nobody writes `?? '<literal>'`.

| Key | Single default | Declared in | Readers (after) |
|---|---|---|---|
| `backend_src` | `src` | schema `.default` | `project-layout.ts` (CLI, every scaffold), `paths.mjs` `BASE_PATHS` → `locations.mjs`, both prompts, `prompt-extension.js`, relationship prompt |
| `frontend_src` | `apps/frontend/src` | schema `.default` | `init-scaffold.ts` (frontend `package.json`), `project scan --write` |
| `entities` | `entities` | schema `.default` | `entities-dir.ts` (CLI context, `entity-naming.mjs`, auth-integrations locals), `init-scaffold.ts` |
| `events_dir` | `events` | schema `.default` | `project-layout.ts` (CLI), entity prompt `loadTopLevelEventYamls` |
| `jobs_dir` | `definitions/jobs` | schema `.default` | `project-layout.ts` |
| `providers` | `definitions/providers` | schema `.default` | `project-layout.ts`, `emitters/frontend/load-context.ts` |
| `generated` | `<backend_src>/generated` | schema transform | `project-layout.ts`, `paths.mjs` `getGeneratedDir`, init |
| `subsystems` | `<backend_src>/shared/subsystems` | schema transform | `project-layout.ts`, CLI context detection |
| `modules_dir` | `<backend_src>/modules` | schema transform | `project-layout.ts` (auth-integrations vendor root, detection) |
| `orchestration_src` | `<backend_src>/orchestration` | schema transform | `project-layout.ts`, `paths.mjs` `BASE_PATHS` |

Directories with no key of their own derive from `backend_src` in `project-layout.ts` only: the vendored runtime root
`<backend_src>/shared` (the `@shared/*` alias target), `app.module.ts`, `main.ts`, `worker.ts`, the root `schema.ts`,
`shared/database/database.module.ts`, and the bridge handlers dir `<backend_src>/jobs`.

`generated` changes meaning only when `backend_src` is set and `generated` is not. It used to be `src/generated`
regardless; it is now `<backend_src>/generated`, next to the code that imports it. With the default `backend_src` both
are `src/generated`.

### `generate.architecture` (charter Q5)

The schema default is the only source: `GenerateConfigSchema.architecture.default('clean')`. The junction prompt's
no-config fallback (`clean-lite-ps`), `barrel-generator.ts` › `resolveArchitecture`'s `?? 'clean'`, and `paths.mjs`
`GENERATE_DEFAULTS` are deleted. Every reader takes `(config ?? DEFAULT_CODEGEN_CONFIG).generate.architecture`.
**One test pins the value** (`config/path-defaults.test.ts`: `DEFAULT_CODEGEN_CONFIG.generate.architecture ===
'clean'`). Q5 becomes a one-line schema change plus that assertion.

Today the schema default is `clean`, while the consumer layout, `project init`'s written value and every smoke
harness are `clean-lite-ps`. `project init` writes `architecture: clean-lite-ps` explicitly, so it is a written choice,
not a reader fallback, and it stays. Whether the default becomes `clean-lite-ps`, or `clean` is retired, is Q5
(owner's call). This PR does not change the value.

The same rule removes the `naming-config.mjs` no-file fallback. `DEFAULT_BACKEND_NAMING` (a hand-written constant in
`naming-config.schema.mjs`) is replaced by `DEFAULT_CODEGEN_CONFIG.naming`, and a test pins the two (#644 nit b).

### One layout helper: `src/cli/shared/project-layout.ts`

- `projectLayout(cwd, config)` returns absolute paths for every key above plus the derived files.
- `importSpecifier(fromFile, toModule)` returns the relative, extension-less, `./`-prefixed POSIX specifier from an
  emitted file to a module.
- `tsconfigAliases(layout, tsconfigDir)` returns `@shared/*`, `@modules/*`, `@generated/*` → `./<rel>/*`.
- `tsconfigIncludes(layout)` returns `<backend_src>/**/*`, plus `<generated>/**/*` when `generated` lies outside
  `backend_src`.

`projectLayout` runs the `paths` block through `ResolvedPathsSchema.parse` itself. That is idempotent on the loader's
parsed config, and it gives the same defaults to a `null` config (no file) or a partial one. Every scaffold-locals
resolver is handed one of those, so none of them needs a defaults path of its own.

It replaces `subsystems-path.ts`, `events-path.ts`, `jobs-path.ts`, `barrel-generator.ts` › `resolveGeneratedDir` /
`resolveBackendSrc` / `resolveArchitecture`, `entity.ts` › `resolveProvidersDir` and `orchestration.ts`'s root
resolver. Those are deleted, and their call sites read the layout.

### Scaffolds (#566, #612)

| Emitter | Target (before → after) | Import specifiers |
|---|---|---|
| `project init` config | unchanged (writes `backend_src`/`entities`/`events_dir`/`generated` from `DEFAULT_CODEGEN_CONFIG`) | — |
| `project init`, with an existing config | every entry below resolves from that config's `paths` (#566) | — |
| `database.module.ts` | `src/shared/database/` → `<shared>/database/` | vendored `../constants/tokens` (sibling under `<shared>`, invariant) |
| vendored runtime (`VENDORED_RUNTIME_FILES`) | `src/shared/<rel>` → `<shared>/<rel>`; `target` becomes relative to `<shared>` | — |
| `modules.ts` / `schema.ts` barrels | `src/generated/` → `<generated>/` | — |
| `app.module.ts` | `src/` → `<backend_src>/` | `importSpecifier(appModule, <shared>/database/database.module)`, `importSpecifier(appModule, <generated>/modules)` |
| root `schema.ts` | `src/` → `<backend_src>/` | `importSpecifier(rootSchema, <generated>/schema)` |
| `main.ts` | `src/` → `<backend_src>/` | `./app.module` (sibling, invariant) |
| `entities/example.yaml` | `entities/` → `<entities>/` | — |
| tsconfig (create + merge) | aliases `./src/shared/*` … → `tsconfigAliases(layout)`; `include` → `<backend_src>/**/*` (+ `<generated>/**/*` when outside it) | — |
| `subsystem install jobs` `worker.ts`, main hook | `src/worker.ts`, `src/main.ts` → `<backend_src>/…` | `./app.module` (sibling) |
| `subsystem install auth` / `observability` / `auth-integrations` | `appModulePath` from the layout (fallback literals deleted) | — |
| `project update` / `project upgrade-openapi` | vendored targets and `app.module.ts` / `main.ts` from the layout | — |
| entity / junction / relationship git-safety | `checkGitSafety(['src'])` → `[<backend_src>, <generated>]` | — |

The relations import that #612 anticipated in `database.module.ts` (`../../generated/relations`, #586) does not exist
on this branch. When REL-1 adds it, it takes `importSpecifier(databaseModule, <generated>/relations)`.

### Hygen side

- `config-loader.mjs` exports `resolvedConfig` (`projectConfig ?? DEFAULT_CODEGEN_CONFIG`) next to `projectConfig`.
- `paths.mjs`: `BASE_PATHS.{backendSrc,orchestrationSrc}` and `getGeneratedDir` read `resolvedConfig.paths`.
  `getGenerateConfig` returns `resolvedConfig.generate`. The dead `frontendSrc`, `FRONTEND_LAYERS`,
  `getFrontendPath`, `PACKAGE_PATHS`, `TEST_OUTPUT_PATHS` and `INJECTABLE_FILES` are deleted: nothing imports them, and
  they carried the second `frontend_src` default.
- `locations.mjs` builds from `resolvedConfig.paths.backend_src`.
- `junction/new/prompt.js` reads `resolvedConfig`-equivalent (`loadProjectConfig(cwd) ?? DEFAULT_CODEGEN_CONFIG`). The
  architecture fallback and the by-architecture `backend_src` fallback are gone.
- `entity/new/prompt.js` › `loadTopLevelEventYamls` reads `paths.events_dir`.
- `relationship/new/prompt.js` `srcRoot` = `paths.backend_src` (was the literal `"src"`).
- `clean-lite-ps/prompt-extension.js`'s final `'src'` fallback becomes `DEFAULT_CODEGEN_CONFIG.paths.backend_src`.
  Unit tests build its locals by hand without `backendSrc`, and the schema value is still the one default.
- The subsystem prompts (`templates/subsystem/{jobs,events,bridge,integration,auth,observability,auth-integrations}`)
  lose their own path fallbacks (`src/main.ts`, `shared/subsystems/...` without `src/`, …). A missing path arg throws
  (`templates/_shared/required-arg.mjs`). The CLI always passes them from the layout.
- The frontend emitter (`emitters/frontend/load-context.ts`) takes `generate.architecture` and `paths.providers`
  through `GenerateConfigSchema` / `ResolvedPathsSchema` instead of its own `'clean'` / `'definitions/providers'`
  fallbacks.
- `entities-dir.ts`: `entitiesDirCandidates` is replaced by `entitiesDirPath(cwd, paths)`, a single value.

### #566 nit: the `EventOfType` placeholder

The no-events `types.ts` emits `EventOfType<T extends EventTypeName> = DomainEvent`. `T` is unused, which a consumer
with `noUnusedParameters` rejects (TS6133). It becomes `T extends EventTypeName ? DomainEvent : never`: the same type
for every `T`, with `T` used. `PayloadOfType` gets the same treatment.

### Census (#644 nit a)

`config-census.test.ts` sweep 2 also matches two more read forms. The first is a bare `config.<block>` /
`config?.<block>` read, which is how the scaffold-locals resolvers read the parsed config they are handed. The second is
literal bracket access, `config['<block>']`. The sweep covers files whose `config` is typed `CodegenConfig` /
`Context['config']`, or `Record<string, unknown>` in a file about `codegen.config.yaml`.

A computed `config[name]` read is allowed only in `subsystem-barrel-generator.ts`, which indexes by `COMPOSABLE_ORDER`
(every one a declared block), and the list is asserted exact. `subsystem-detect.ts`'s narrowed read is typed, so TS
checks it. Sweep 1 now also counts `resolvedConfig`, `DEFAULT_CODEGEN_CONFIG` and `configOrDefaults(…)` reads, plus
`project-layout.ts`'s own `paths.<key>`. It also asserts the converse: every declared `paths` key has a reader.

A second test (`config/path-defaults.test.ts`) greps `src/` and `templates/` for a fallback. It catches a literal
(`'app/backend/src'`, `?? 'src'`, `?? 'entities'`, `?? 'src/generated'` and the like, or `|| 'src'`). It also
catches a built path, `?? path.resolve(` / `?? path.join(` / `|| path.…(`, which the first revision missed. One
exact, asserted-present exception is listed: `runtime-copier.ts`'s `depsTargetRoot`, an option default derived from
the install target, not a `paths.*` default.

`cli/entity.test.ts` adds a case where `paths.entities: definitions/entities` does not exist and a stale `entities/`
does. `entity new --all`, `entity list` and `entity validate` each exit 1, naming `definitions/entities`, and never
read the stale directory. All three cases fail on the pre-fix code.

## Gate

A new leg in the existing junction harness: `run-smoke-junction.ts --layout custom`, in `just test-smoke-junction`
for both runtimes. It writes `codegen.config.yaml` *before* `project init` with

```yaml
paths:
  backend_src: apps/backend/src
  generated: apps/backend/src/codegen
  entities: definitions/entities
```

then runs, in order:

1. `project init --with-tsconfig`
2. `subsystem install events` and `subsystem install jobs` (#566's repro: `worker.ts` and the `main.ts` hook must land
   under `apps/backend/src`)
3. `entity new --all` and `junction new --all`
4. `tsc`
5. the emission / barrel / specifier assertions, now layout-parametrised
6. an assertion that nothing was written to `<tmp>/src` or `<tmp>/entities`
7. the DI boot gate

The custom leg does not exercise a *missing* `paths.entities`, because init creates the directory. The unit case
above covers that.

## Found

1. **The clean-lite-ps barrels used the wrong root with no `backend_src`.** `barrel-generator.ts` defaulted to
   `app/backend/src` and applied it to clean-lite-ps as well. Its doc comment said "ignored for clean-lite-ps", which
   was not true. A project that omitted `backend_src` got barrels importing `app/backend/src/modules/…`, while the
   modules were emitted under `src/`. Fixed by the single default; the barrel unit expectations now read
   `../modules/…`.
2. **`subsystem install jobs` wrote `src/worker.ts` and hooked `src/main.ts` regardless of config** (the #566 report).
   The subsystem prompts also carried their own fallbacks, one of which (`shared/subsystems/…`) had no `src/` at all.
3. **Readers probed fallback chains.** Subsystem detection tried four roots in both `context.ts` and
   `subsystem-detect.ts`: `paths.subsystems`, `src/shared/subsystems`, `src/subsystems` and `shared/subsystems`.
   Entities had the most: `entities-dir.ts` tried `paths.entities`, then `<cwd>/entities`. On top of that,
   `ctx.entitiesDir`, which is `null` when the configured directory does not exist, had seven
   `?? path.resolve(ctx.cwd, 'entities')` fallbacks:
   - `entity.ts` (`new --all`, the `emits:` pre-flight, the barrel plan, `validate`)
   - `junction.ts`
   - `relationship.ts`
   - `project.ts` (`validate`), plus `project analyze`'s `ctx.entitiesDir ?? …`

   So a misconfigured `paths.entities` next to a stale `entities/` silently read the wrong directory. The first
   revision of this PR missed those seven; the orchestrator's review caught them. They now read
   `projectLayout(ctx.cwd, ctx.config).entities`. `Context.entitiesDir` is **deleted**: nothing needs a nullable
   copy of the configured path. Callers that need the directory to exist check for it and report the configured
   path. `ctx.entityCount` still counts the configured directory.
4. **`project upgrade-openapi` kept a private copy** of `runtimeRoot` / `loadRuntimeFile` and of the OpenAPI slice
   of `VENDORED_RUNTIME_FILES`. It now imports them.
5. **`paths.mjs` exported six things nothing imported** (`FRONTEND_LAYERS`, `getFrontendPath`, `PACKAGE_PATHS`,
   `TEST_OUTPUT_PATHS`, `INJECTABLE_FILES`, `BASE_PATHS.frontendSrc`), carrying a second `frontend_src` default
   (`app/frontend/src`). Deleted.
6. **#612's `database.module.ts` relations import does not exist on this branch.** #586 has not landed. When REL-1
   adds it, it takes `importSpecifier(layout.databaseModule, <generated>/relations)`.
7. **Two keys are read consistently but not honoured by every emitter.** The entity/relationship pipelines and
   `barrel-generator.ts` hard-code `<backend_src>/modules`, ignoring `paths.modules_dir`. The vendored
   `@shared/subsystems/*` imports assume `paths.subsystems` is `<backend_src>/shared/subsystems`. The `patterns`
   default glob is `src/…`. Filed: **#645**.
8. **The `clean` junction smoke asserts `app/backend/src/…`** while its own config sets `backend_src: src`. It never
   gets that far (tsc is red first, #602), so this is unchanged. It is recorded here for whoever turns #602 green.
9. **The junction prompt's no-config fallback that CFG-0 Found 9 recorded** (`clean-lite-ps`) is gone. The four
   junction-naming unit cases that relied on it now declare `architecture: clean-lite-ps` in their config.

## Gates

Run after the last code edit (commit `8f59f04`, the review revision). The later commit changes only this table.
Earlier-revision note: `b8c80a8` was comment-only, touching six lines in five files.

| Gate | Result |
|---|---|
| `bun run typecheck && bun run build && bun run test` | pass (baseline runner, `clean` pipeline, byte-identical) |
| `just test-all` | pass: 3454 unit tests, 0 fail. New: `config/path-defaults.test.ts` and the stale-`entities/` cases in `cli/entity.test.ts`; the census is extended. Also: baseline; every smoke, including the `junction --layout custom` legs (events + jobs installs) in both runtimes; junction snapshots unchanged (10 pass); integration-emit (56 pass); smoke-integration |
| `just test-integration` | pass: 74 pass, 0 fail, 2 skip (the pre-existing `test.skip` pair in `bridge-e2e.test.ts`) |
| `just test-smoke-junction-clean` | known-red, unchanged: **118** errors (110 × TS2307 + 8 × TS7006, #602) |
| `just test-post-publish` | pass: the shipped templates resolve `project-config.ts` (`DEFAULT_CODEGEN_CONFIG`) from the tarball |
