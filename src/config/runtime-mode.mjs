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

import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

const PACKAGE = "@pattern-stack/codegen";

/**
 * Read the `runtime` mode from `codegen.config.yaml` at `cwd`. Defaults to
 * `package` (ADR-037) when the file/key is absent or invalid.
 * @returns {'package' | 'vendored'}
 */
export function loadRuntimeMode(cwd = process.cwd()) {
  const configPath = path.resolve(cwd, "codegen.config.yaml");
  if (!fs.existsSync(configPath)) return "package";
  try {
    const parsed = yaml.parse(fs.readFileSync(configPath, "utf-8"));
    return parsed?.runtime === "vendored" ? "vendored" : "package";
  } catch {
    return "package";
  }
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
