/**
 * Runtime mode resolver — `.mjs` twin of `src/cli/shared/runtime-import.ts`
 * (ADR-037), for the Hygen entity templates that run in a subprocess and can
 * only import plain ESM. Keep the two in sync: both map a runtime mode +
 * logical subpath to the concrete import specifier.
 *
 *   - `package`  → `@pattern-stack/codegen/subsystems` +
 *                  `@pattern-stack/codegen/runtime/<relpath>`.
 *   - `vendored` → `@shared/subsystems/<name>` + `@shared/<relpath>` (the
 *                  convention the entity templates have always emitted).
 *
 * NOT routed through here: consumer-app files the package never owns and that
 * `project init` always scaffolds locally regardless of mode —
 * `@shared/database/*`, `@shared/http/*`, `@shared/openapi`, `@shared/pipes/*`,
 * `@shared/connections/*`. Those stay `@shared/*` in both modes.
 */

import { loadProjectConfig } from "./project-config.js";

const PACKAGE = "@pattern-stack/codegen";

/**
 * The `runtime` mode of the project at `cwd`, from the parsed config
 * (`project-config.ts`, CFG-0). `package` (ADR-037) when there is no config
 * file; an invalid file throws `CodegenConfigError`.
 * @returns {'package' | 'vendored'}
 */
export function loadRuntimeMode(cwd = process.cwd()) {
  return loadProjectConfig(cwd)?.runtime ?? "package";
}

/**
 * Import specifier for a subsystem barrel.
 * @param {'package' | 'vendored'} mode
 * @param {string} [subsystem] logical subsystem name (`events`, `integration`,
 *   `auth`, …) — selects the vendored per-subsystem barrel; ignored in package
 *   mode (one barrel serves all).
 */
export function subsystemsImport(mode, subsystem) {
  if (mode === "vendored") {
    return subsystem ? `@shared/subsystems/${subsystem}` : "@shared/subsystems";
  }
  return `${PACKAGE}/subsystems`;
}

/**
 * Import specifier for a non-subsystem runtime file (base-classes, types,
 * constants, helpers). `relpath` is the path under the runtime root WITHOUT a
 * leading slash (e.g. `base-classes/integrated-entity-repository`,
 * `constants/tokens`, `types/drizzle`, `eav-helpers`).
 * @param {'package' | 'vendored'} mode
 * @param {string} relpath
 */
export function runtimeImport(mode, relpath) {
  const clean = String(relpath).replace(/^\/+/, "");
  return mode === "vendored" ? `@shared/${clean}` : `${PACKAGE}/runtime/${clean}`;
}

/**
 * Rewrite a legacy `@shared/<relpath>` specifier to the mode-correct form. Used
 * to convert pattern-library base-class imports (authored as `@shared/...`) to
 * the package form in package mode without duplicating the path in every
 * pattern. A non-`@shared/` specifier (app-defined pattern alias, e.g.
 * `@/patterns/...`) is returned untouched.
 * @param {'package' | 'vendored'} mode
 * @param {string} specifier
 */
export function rewriteSharedImport(mode, specifier) {
  if (mode === "vendored") return specifier;
  if (typeof specifier !== "string" || !specifier.startsWith("@shared/")) {
    return specifier;
  }
  return runtimeImport(mode, specifier.slice("@shared/".length));
}

/**
 * Every mode-resolved runtime import specifier the entity templates emit, as
 * the `*Import` locals `templates/entity/new/prompt.js` passes to them. One
 * table, so the unit tests that render backend bodies use the prompt's
 * values rather than a fallback of their own (#638).
 * @param {'package' | 'vendored'} mode
 */
export function runtimeImportLocals(mode) {
  return {
    // TypedEventBus token + DrizzleClient token/type. In `vendored` mode the
    // consumer wires `@shared/*` to the vendored runtime under `src/shared/…`
    // (subsystem barrel at `<subsystems_root>/events/index.ts`).
    eventsTokenImport: subsystemsImport(mode, "events"),
    typedEventBusImport: subsystemsImport(mode, "events"),
    drizzleTokenImport: runtimeImport(mode, "constants/tokens"),
    drizzleTypeImport: runtimeImport(mode, "types/drizzle"),
    // ADR-043 §5: use-cases read the acting principal from the ambient
    // RequesterContext (ALS), never from self-asserted request headers.
    tenantContextImport: runtimeImport(mode, "base-classes/tenant-context"),
    // Pagination contract (pagination-by-default). ASYMMETRIC by mode:
    //   - package  → `@pattern-stack/codegen/runtime/http/pagination` (Page<T>,
    //     ListQuerySchema, resolveListQuery, buildPage, cursor codec).
    //   - vendored → `@shared/http/page` (vendored to `src/shared/http/page.ts`
    //     by project init's VENDORED_RUNTIME_FILES). DISTINCT from the consumer's
    //     OPTIONAL `@shared/http/pagination` search contract ({items,total,limit,
    //     offset}) — vendoring the Page<T> envelope to `/pagination` would
    //     clobber it, so the list envelope lives at `/page`.
    // Unlike most @shared/http/* files (which the package never owns), THIS one
    // IS package-published — the list endpoint is unconditional, so its contract
    // must ship with codegen (package mode) and be vendored (vendored mode).
    paginationImport:
      mode === "vendored" ? "@shared/http/page" : runtimeImport(mode, "http/pagination"),
    // Integration subsystem barrel (ADR-033.1 inline-sync `integration-source`
    // module — emitted only for entities with an inline `detection:` block).
    integrationSubsystemImport: subsystemsImport(mode, "integration"),
    withAnalyticsImport: runtimeImport(mode, "base-classes/with-analytics"),
    integrationUpsertConfigImport: runtimeImport(mode, "base-classes/integration-upsert-config"),
    baseRepositoryImport: runtimeImport(mode, "base-classes/base-repository"),
    eavHelpersImport: runtimeImport(mode, "eav-helpers"),
    zodValidationPipeImport: runtimeImport(mode, "pipes/zod-validation.pipe"),
    // OpenAPI barrel: the runtime source lives at `runtime/shared/openapi`, but
    // the VENDORED target drops the leading `shared/` (vendored alias is
    // `@shared/openapi`, NOT `@shared/shared/openapi`). Package mode keeps the
    // full runtime relpath.
    openApiImport:
      mode === "vendored" ? "@shared/openapi" : runtimeImport(mode, "shared/openapi"),
  };
}
