/**
 * Runtime import resolver (ADR-037).
 *
 * The single place that decides which copy of the framework runtime generated
 * code imports from. Keyed off the project's `runtime` mode:
 *
 *   - `package`  → `@pattern-stack/codegen/subsystems` (single barrel) +
 *                  `@pattern-stack/codegen/runtime/<relpath>` for non-subsystem
 *                  runtime files (base-classes, types, constants, …).
 *   - `vendored` → the consumer's `@shared/*` aliases (the convention the entity
 *                  templates have always emitted) — `@shared/subsystems/<name>`
 *                  + `@shared/<relpath>`.
 *
 * EVERY hardcoded runtime specifier in the generators routes through here, so
 * the two emission shapes never drift and a new project gets the package model
 * by default. `vendored` mode is byte-for-byte unchanged from the pre-ADR-037
 * emission.
 *
 * NOT routed through here: consumer-app files the package never owns and that
 * `project init` always scaffolds locally regardless of mode —
 * `@shared/database/database.module`, `@shared/http/pagination`,
 * `@shared/openapi`, `@shared/connections/*`. Those have no package specifier
 * and stay `@shared/*` in both modes.
 */

export type RuntimeMode = 'package' | 'vendored';

/** The npm package the runtime is published under. */
const PACKAGE = '@pattern-stack/codegen';

/**
 * Resolve the effective runtime mode from a (possibly partial) project config.
 * Defaults to `package` (ADR-037) when the key is absent or invalid — matching
 * the schema default in `pipelines-config.schema.ts`.
 */
export function resolveRuntimeMode(
  config: { runtime?: unknown } | null | undefined,
): RuntimeMode {
  return config?.runtime === 'vendored' ? 'vendored' : 'package';
}

/**
 * Import specifier for the subsystems runtime.
 *
 * In `package` mode every subsystem resolves to the single published barrel
 * (`@pattern-stack/codegen/subsystems`) — the package exposes one `./subsystems`
 * export that re-exports all subsystems. In `vendored` mode each subsystem has
 * its own vendored barrel under `@shared/subsystems/<name>`.
 *
 * @param subsystem logical subsystem name (`events`, `integration`, `auth`, …).
 *   Required for vendored mode (selects the per-subsystem barrel); ignored in
 *   package mode (one barrel serves all).
 */
export function subsystemsImport(mode: RuntimeMode, subsystem?: string): string {
  if (mode === 'vendored') {
    return subsystem ? `@shared/subsystems/${subsystem}` : '@shared/subsystems';
  }
  return `${PACKAGE}/subsystems`;
}

/**
 * Import specifier for a non-subsystem runtime file — base classes, types,
 * constants, helpers, pipes. `relpath` is the path under the runtime root
 * WITHOUT a leading slash (e.g. `base-classes/integrated-entity-repository`,
 * `constants/tokens`, `types/drizzle`, `eav-helpers`).
 *
 * Package mode resolves it through the package's `./runtime/*` export; vendored
 * mode through the consumer's `@shared/*` alias.
 */
export function runtimeImport(mode: RuntimeMode, relpath: string): string {
  const clean = relpath.replace(/^\/+/, '');
  return mode === 'vendored'
    ? `@shared/${clean}`
    : `${PACKAGE}/runtime/${clean}`;
}
