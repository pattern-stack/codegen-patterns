# PATH-0 — one default per `paths.*` key; every reader and every scaffold goes through it

**Status:** Design
**Date:** 2026-09-18
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
- `clean-lite-ps/prompt-extension.js` drops its final `'src'` fallback; `baseLocals.backendSrc` is always set.

### #566 nit: the `EventOfType` placeholder

The no-events `types.ts` emits `EventOfType<T extends EventTypeName> = DomainEvent`. `T` is unused, which a consumer
with `noUnusedParameters` rejects (TS6133). It becomes `T extends EventTypeName ? DomainEvent : never`: the same type
for every `T`, with `T` used. `PayloadOfType` gets the same treatment.

### Census (#644 nit a)

`config-census.test.ts` sweep 2 also matches a bare `config.<block>` / `config?.<block>` read, which is how
scaffold-locals files that hold the parsed config as `config` read it, and bracket access
`config[…'<block>']`. Dynamic `config[name]` is allowed only in `subsystem-detect.ts` (narrowed to the six `backend`
blocks, CFG-0), and that exception is asserted exact.

## Gate

A new leg in the existing junction harness: `run-smoke-junction.ts --layout custom`, in `just test-smoke-junction`
for both runtimes. It writes `codegen.config.yaml` *before* `project init` with

```yaml
paths:
  backend_src: apps/backend/src
  generated: apps/backend/src/codegen
  entities: definitions/entities
```

then runs `project init --with-tsconfig`, `subsystem install events`, `entity new --all`, `junction new --all`,
`tsc`, the emission/barrel/specifier assertions (now layout-parametrised), an assertion that nothing was written to
`<tmp>/src` or `<tmp>/entities`, and the DI boot gate.

## Found

Filled in at implementation.

## Gates

Filled in after the last edit.
