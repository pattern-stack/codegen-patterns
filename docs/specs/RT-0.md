# RT-0 — junction + relationship templates resolve runtime imports by mode

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
**Issue:** #624
**Project:** #578
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · ADR-037 (runtime mode)

`junction new` and `relationship new` hardcoded `@shared/*` for package-owned runtime files. Under `runtime:
package` (the ADR-037 default) nothing is vendored to `src/shared/**`, so their output did not compile. The entity
pipeline already resolves these specifiers by mode; the two prompts never adopted it.

## Charter invariants this PR touches

- **I1 declare once.** Both prompts call the entity pipeline's resolver (`loadRuntimeMode` + `runtimeImport` from
  `src/config/runtime-mode.mjs`). There is no second mapping.
- **I2 / I7.** Vendored output is byte-identical (the 10 junction snapshots are unchanged). The interim expectation
  is deleted, not kept as a shim.
- **I9 honest gates.** The capability smoke's package leg passes with **zero** expectations, like the vendored
  leg. The junction smoke gains a package leg. No filter was added.
- **I11 scope.** `templates/junction/new` + `templates/relationship/new` and their harnesses only.

## What changed

| Specifier (vendored form) | junction | relationship | Local |
|---|---|---|---|
| `@shared/constants/tokens` | repository, service | repository, service | `drizzleTokenImport` |
| `@shared/types/drizzle` | repository | repository | `drizzleTypeImport` |
| `@shared/base-classes/junction-integration-repository` | repository (×2) | — | `junctionIntegrationRepositoryImport` |
| `@shared/base-classes/base-repository` | — | repository | `baseRepositoryImport` |
| `@shared/base-classes/with-analytics` | service | service | `withAnalyticsImport` |
| `@shared/base-classes/base-service` | service | service | `baseServiceImport` |

Each local is `runtimeImport(loadRuntimeMode(cwd), '<relpath>')`: `@shared/<relpath>` vendored,
`@pattern-stack/codegen/runtime/<relpath>` under `package`. The local names match the entity pipeline's
(`templates/entity/new/prompt.js`). `@shared/database/database.module` is consumer-local in both modes and stays.

## Gates

- **`test/smoke/run-smoke-junction.ts --runtime vendored|package`** (default `vendored`). `just test-smoke-junction`
  and `just test-smoke-junction-cross-domain` each run both legs. Each leg runs tsc, the emission greps, a per-mode
  specifier assertion, and the AppModule boot. Checked against the old templates, the package leg fails with the
  #624 diagnostics.
- **`test/junction/_helpers.ts`** takes `runtime?: 'vendored' | 'package'` (default `vendored`, which the snapshots
  lock).
- **Relationship coverage** is the capability smoke. It runs `relationship new` (`crew_assignment`) in both legs.
  `test-smoke-relationship` covers the vendored flow as well.
- **`applyIssue624Expectation`**, `issue624Junction` and `issue624Relationship` are deleted, along with the CLAUDE.md
  named-expectation row.

## Found during implementation

1. **A sixth specifier.** `@shared/base-classes/base-repository` is imported only by `relationship new`. The issue
   did not list it, but it was already in the interim expectation. It is routed like the other five.
2. **No runtime export change was needed.** `package.json` `exports` has `./runtime/*` → `dist/runtime/*`, and
   `dist/runtime/base-classes/junction-integration-repository.js` is built. `just test-post-publish` confirms the
   tarball resolves all six.
3. **One package-runtime alias helper.** The step that aliases `@pattern-stack/codegen/runtime/*` (and
   `/subsystems`, `@nestjs/*`) to the in-repo runtime for checkout smokes was private to the capability smoke. It
   is now `test/smoke/_package-runtime.ts`, used by the capability smoke and the junction bootstrap.
   `test/smoke-integration/run.ts` still has its own copy.
4. **Both junction scenarios get the package leg.** Intra-domain (`opportunity × contact`) and cross-domain
   (`opportunity × activity`) run vendored + package. The `clean` variants stay vendored-only (known-red, #602).
5. **The junction prompt accepted `codegen.config.yml`.** Its local `loadCodegenConfig` also read `.yml`, but
   `loadRuntimeMode` and every other loader read `codegen.config.yaml` only. A `.yml`-only project would have taken
   architecture/srcRoot from the `.yml` and silently used the default runtime mode. The `.yml` candidate is dropped
   (I1: one config filename).

## Gate results (final run)

| Gate | Result |
|---|---|
| `bun run typecheck && bun run build && bun run test` | ✅ |
| `just test-all` | ✅ exit 0. Unit **3351 pass / 0 fail** · baseline · smoke · subsystems (vendored + package) · relationship · **junction ×4: intra-domain + cross-domain × vendored + package** · **capability (vendored + package), zero expectations** · junction snapshots **10/10 unchanged** (vendored byte-identical) · integration-emit 56/56 · smoke-integration |
| `just test-integration` | ✅ 74 pass / 0 fail |
| `just test-smoke-junction-clean` | known-red, **118** (unchanged, #602) |
| `just test-post-publish` | ✅ tarball smoke passed |

## Out of scope / still true

- `relationship new` still hardcodes `srcRoot = 'src'` (NAME-1).
- The `clean` junction pipeline stays known-red (#602). Its junction smoke runs the vendored leg only.
