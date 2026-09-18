# PATH-1 — `paths.modules_dir` is honoured by every emitter, `paths.subsystems` is deleted, the `patterns` default follows `backend_src`

**Status:** Implemented
**Date:** 2026-09-18 · **Implemented:** 2026-09-18
**Issue:** #645
**Project:** #578
**Depends on:** PATH-0 (#642, #646): one default per `paths.*` key, `projectLayout` / `importSpecifier`
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Operating
Principles (no backwards compatibility)

## Why

PATH-0 gave every `paths.*` key one default and routed every reader through it. Two keys were read consistently but
not honoured by every emitter, and one top-level default ignored `paths.backend_src`:

| Key | Honoured by (before) | Ignored by (before) |
|---|---|---|
| `paths.modules_dir` | `auth-integrations` vendor root, subsystem detection, the `@modules/*` tsconfig alias | the clean-lite-ps entity pipeline (`entity-naming.mjs` › `entityModuleNaming` → `<backend_src>/modules/…`), the library-capability junction import (`prompt-extension.js` › `modulesRoot`), the junction prompt (clean-lite-ps output paths, the junction module dir), the relationship prompt, `barrel-generator.ts` › `entityFilePaths`, the integration assembly / sink imports (`assembly-emission-generator.ts` › `resolveEntityModuleImports`) |
| `paths.subsystems` | `subsystem install` target, generated `events/` / `jobs/` output, detection | every vendored import (`runtime-import.ts` emits `@shared/subsystems/<name>`, `@shared/*` → `<backend_src>/shared`), and `subsystem install`'s own closure copy (`depsTargetRoot = <subsystems>/..`, i.e. it assumes the parent is the `@shared` root) |
| `patterns` (default glob) | — | `src/patterns/*.pattern.ts` regardless of `paths.backend_src`; two readers (`pattern-globs.ts`, the entity prompt) re-applied the literal when the list was empty |

Setting either key to a non-default value produced a project that did not compile or did not wire.

## Charter invariants this PR touches

- **I1 declare once.** `modules_dir` is read through the resolved `paths` block by every emitter that locates an
  entity module; the `patterns` default is declared once, in the schema, derived from `backend_src` like the other
  derived keys. The two reader-side `'src/patterns/*.pattern.ts'` literals are deleted.
- **I7 no backwards compatibility.** `paths.subsystems` is deleted — its only honest value is the derived one. The
  dead per-entity `entity.src_root` override in the clean-lite-ps extension (the entity schema is `.strict()` and has
  no such key) is deleted. `patterns: []` now means "no app patterns"; it is no longer silently replaced by the default.
- **I9 gates are honest.** The existing `--layout custom` junction leg proves the new behaviour in both runtimes.
- **I11 scope.** Generator plumbing only. Default-path output is byte-identical: baseline, junction snapshots and
  every other smoke are unchanged.

## Decisions (per key)

### `paths.modules_dir` — keep, and honour it everywhere

A monorepo consumer plausibly wants its module tree somewhere other than `<backend_src>/modules` (e.g.
`apps/backend/src/domain`), the `@modules/*` alias already points at it, and after PATH-0 the value is one resolved
string. Honouring it is a parameter change at each site; deleting it would still need every site changed to derive
`<backend_src>/modules` from one place.

`modules_dir` is the root of the **clean-lite-ps** module tree (plus the `auth-integrations` vendor root, which lives
next to the `connection` entity module). The `clean` pipeline's layout is `locations:` (`infrastructure/modules`,
`domain/`, …) and does not read it.

| Emitter | Before | After |
|---|---|---|
| `templates/_shared/entity-naming.mjs` › `entityModuleNaming(block, modulesDir)` | 2nd arg `srcRoot`, built `${srcRoot}/modules[/<context>]/<plural>` | 2nd arg is the modules root (`paths.modules_dir`); builds `${modulesDir}[/<context>]/<plural>` |
| `paths.mjs` › `BASE_PATHS` | `backendSrc`, `orchestrationSrc` | + `modulesDir: resolvedConfig.paths.modules_dir` |
| entity prompt → clean-lite-ps extension | locals `backendSrc`; extension's `srcRoot` = `baseLocals.srcRoot \|\| entity.src_root \|\| baseLocals.backendSrc \|\| default` | locals `modulesDir: BASE_PATHS.modulesDir`; extension's `modulesDir` = `baseLocals.modulesDir \|\| DEFAULT_CODEGEN_CONFIG.paths.modules_dir` (the schema's one default, for hand-built unit locals) |
| `resolveLibraryCapabilityConfig` (`Communication` junction import) | `${srcRoot}/modules/<junctionPlural>/…` | `${modulesDir}/<junctionPlural>/…` |
| junction prompt | clean-lite-ps output paths `${backend_src}/modules/<plural>/…`, junction module dir, endpoint naming | all from `paths.modules_dir` |
| relationship prompt | `srcRoot = backend_src`, `${srcRoot}/modules/<plural>` | `modulesDir = paths.modules_dir` |
| `barrel-generator.ts` › `entityFilePaths` (clean-lite-ps) | `${backendSrc}/modules[/<ctx>]/<plural>/…` | `${modulesDir}[/<ctx>]/<plural>/…` |
| `assembly-emission-generator.ts` › `resolveEntityModuleImports` | `<backendSrcAbs>/modules[/<ctx>]/<plural>/…` | `<modulesAbs>[/<ctx>]/<plural>/…` (new required input `modulesAbs`); `emitAdapters` passes `layout.modules` |
| `tsconfigIncludes(layout)` | `<backend_src>/**/*` + `<generated>/**/*` when outside | + `<modules_dir>/**/*` when outside `backend_src` |
| entity / junction / relationship git-safety | `checkGitSafety([<backend_src>, <generated>])` | `[<backend_src>, <modules_dir>, <generated>]` |

Imports between module files are already relative (computed from these dirs by `relativeModuleDir`), and imports out
of a module go through `@shared/*` or the runtime package, so no other specifier changes.

### `paths.subsystems` — delete it

The vendored runtime is reachable only through `@shared/subsystems/<name>` (vendored mode) or the package barrel, and
`@shared/*` maps to `<backend_src>/shared`. `subsystem install` also copies each subsystem's runtime closure into
`<subsystems>/..`, i.e. it already assumes the parent of the subsystems root **is** the `@shared` root. A
`paths.subsystems` anywhere else vendors the runtime where no import reaches it; making it work would need a second
alias that nothing has asked for. Its only honest value is `<backend_src>/shared/subsystems`.

- `PathsConfigSchema` loses `subsystems`; a config that sets it is a strict-schema error naming the key.
- `resolvePathDefaults` loses the derived default.
- `ProjectLayout.subsystems` stays, derived as `path.join(shared, 'subsystems')` next to `shared` — a location with no
  key of its own, like `databaseModule`.
- `subsystem install --target <dir>` (an explicit CLI argument, not config) is unchanged.
- Docs that wrote `<paths.subsystems>` now write `<backend_src>/shared/subsystems`.

### `patterns` — derive the default from `backend_src`

`PatternsConfigSchema` becomes `z.array(z.string()).optional()`, and `CodegenConfigSchema` fills an absent `patterns`
with `[<backend_src>/patterns/*.pattern.ts]` in a top-level transform (`resolveConfigDefaults`), after `paths` is
resolved. The object schema stays exported as `CodegenConfigObjectSchema` for its `.shape` (census, error hints).
Every reader takes `config.patterns` as-is: `pattern-globs.ts`'s `DEFAULT_PATTERN_GLOBS` and the entity prompt's
`['src/patterns/*.pattern.ts']` literal are deleted. `patterns: []` is an explicit "no app patterns".

## Gate

The existing `run-smoke-junction.ts --layout custom` leg (both runtimes, in `just test-smoke-junction`) additionally:

1. writes `paths.modules_dir: apps/backend/src/domain` into the pre-init config;
2. authors an app capability pattern at `apps/backend/src/patterns/audited.pattern.ts` (no `patterns:` key — the
   derived default must find it) whose mixin lives at `<modules_dir>/capabilities/with-audited.ts` and is imported as
   `@modules/capabilities/with-audited`;
3. writes a `ledger` entity YAML (`patterns: [Base, Audited]`) next to the copied fixtures;
4. asserts every clean-lite-ps module (entities + junction) lands under `apps/backend/src/domain/…`, nothing under
   `apps/backend/src/modules/`, the modules barrel imports from `../domain/…`, and the ledger repository applies
   `WithAudited(` — so the pattern loaded from the non-default glob;
5. `tsc` and the DI boot gate pass (the `@modules/*` alias resolves to the custom modules dir).

Default-path output is byte-identical: baseline, junction snapshots and the other smokes.

Unit: `config/path-defaults.test.ts` pins the `patterns` default (default config and a custom `backend_src`), and
the schema rejects `paths.subsystems`; `project-layout` covers `modules_dir` outside `backend_src` in
`tsconfigIncludes`; the barrel / assembly / naming units cover a non-default `modules_dir`.

## Found

1. **`subsystem install` already assumed the subsystems root's parent is the `@shared` root.** It copies each
   subsystem's runtime closure (base classes, constants, …) into `<subsystems>/..`. So a non-default
   `paths.subsystems` broke the vendored closure too, not only the `@shared/subsystems/*` imports. This confirmed
   the delete.
2. **Two more `<backend_src>/modules` hard-codes than #645 listed.** `assembly-emission-generator.ts` ›
   `resolveEntityModuleImports`, which the integration assemblies and sinks import through, built
   `<backend_src>/modules/…` itself. The junction prompt's clean-lite-ps output paths did too, not only its module
   dir. Both now read `modules_dir`: `resolveEntityModuleImports` takes a required `modulesAbs`, and `emitAdapters`
   throws if it gets `backendSrcAbs` without it.
3. **A third one in the capability path.** The library `Communication` capability's junction-table import
   (`resolveLibraryCapabilityConfig`) built `${srcRoot}/modules/<junction>/…` on its own. It now reads `modulesDir`.
4. **A dead per-entity override.** The clean-lite-ps extension read `entity.src_root` before `paths.backend_src`.
   The entity block is `.strict()` and declares no `src_root`, so a YAML with it fails validation first. Deleted,
   along with the `baseLocals.srcRoot` / `baseLocals.backendSrc` chain. The extension takes one local, `modulesDir`.
5. **`patterns: []` meant "the default".** Both the CLI (`resolvePatternGlobs`) and the entity prompt re-applied
   `src/patterns/*.pattern.ts` for an empty list. The schema's default made the empty list reachable only when
   written explicitly. It now means what it says: no app patterns.
6. **The `clean` pipeline does not read `modules_dir`.** Its module layout comes from `locations:`
   (`infrastructure/modules`, `domain/`, …). `modules_dir` is documented as the clean-lite-ps module tree.
7. **The consumer docs gave the wrong subsystems default.** `docs/consumer/events.md`, `integration.md` and the events
   skill said "defaulting to `shared/subsystems/…`", with no `src/`. Corrected to
   `<backend_src>/shared/subsystems/…` (default `src/shared/subsystems/…`).
8. **Pre-existing, filed: #647.** The clean-lite-ps EAV `FieldValueService` imports are hand-built
   (`'../field_values/…'`, `'../../field_values/…'`). They break for a `context:`-tagged EAV entity, or for a
   field-value entity with another `plural:` / `context:`. This is the NAME-0 class, and it is not a `modules_dir`
   defect: the path is relative inside the one tree.

## Gates

(filled after the last edit)
