/**
 * Frontend emitter — version-pairing contract (ADR-038, FE-2; corrected by FE-0).
 *
 * The emitter emits imports against these package ranges; the generated app's
 * frontend `package.json` must install them. `@pattern-stack/codegen` itself
 * gains no runtime dependency — this constant is the single source of truth for
 * the pairing, surfaced into `generated/index.ts` (FE-3) so drift is visible in
 * the consumer.
 *
 * ## Why three of these are pinned EXACTLY (FE-0, #620)
 *
 * `@tanstack/react-db`, `@tanstack/electric-db-collection` and
 * `@tanstack/query-db-collection` each declare `@tanstack/db` as an **exact**
 * dependency, and they release in lockstep. Ranging them with carets let the
 * three drift onto three different `@tanstack/db` versions, and a fourth
 * arrived bundled with `@pattern-stack/frontend-patterns` — four copies, four
 * type identities, and `createCollection(electricCollectionOptions(...))` (what
 * `emit-collections.ts` writes) stopped compiling with a `sync.sync` mismatch
 * naming two of them. Measured in `docs/specs/FE-0.md`; the frontend analogue
 * of the dual-`drizzle-orm` hazard DRZ-2 fixed.
 *
 * So the four `@tanstack/db`-bearing packages are pinned to the set that agrees
 * (below), and {@link FRONTEND_DEP_OVERRIDES} collapses the copy
 * `@pattern-stack/frontend-patterns` bundles. `0.5.33` is inside that package's
 * own `^0.5.11` and is the version it resolves to anyway, so the override
 * deduplicates rather than upgrades.
 *
 * Moving the set forward is a deliberate, one-commit change: pick another row
 * of the lockstep table and let `just test-smoke-frontend` prove the emitted
 * tree still compiles.
 *
 * See docs/specs/2026-06-04-frontend-pipeline-rebuild.md → "Version pairing",
 * and docs/specs/FE-0.md.
 */

export const FRONTEND_EMITTED_DEPS = {
	// The sync layer (`createEntityHooks` / `createStore`). Stays on the alpha
	// line: the `1.0.0` published on npm ships no `dist/sync` at all and is not
	// dist-tagged `latest` (docs/specs/FE-REL.md §2.1).
	'@pattern-stack/frontend-patterns': '^0.2.0-alpha.18',
	// `snakeCamelMapper`, imported by every emitted electric collection. The
	// range `@tanstack/electric-db-collection@0.2.41` itself declares, so no
	// second copy. Previously undeclared and resolved only by hoisting (FE-0).
	'@electric-sql/client': '^1.5.12',
	// ── the lockstep set — change these four together, never one of them ──
	'@tanstack/db': '0.5.33',
	'@tanstack/react-db': '0.1.77',
	'@tanstack/electric-db-collection': '0.2.41',
	'@tanstack/query-db-collection': '1.0.30',
	// ── end lockstep set ──
	// No `@tanstack/db` in its tree, so a caret is safe here.
	'@tanstack/react-query': '^5.0.0',
} as const;

export type FrontendEmittedDeps = typeof FRONTEND_EMITTED_DEPS;

/**
 * Package-manager overrides the generated frontend `package.json` must carry.
 *
 * `$@tanstack/db` resolves every transitive copy to the direct dependency
 * declared in {@link FRONTEND_EMITTED_DEPS} — so the version lives in exactly
 * one place. Verified on **bun** (one copy under `node_modules/@tanstack/db`)
 * and **npm** (`overridden` + `deduped`). pnpm reads `pnpm.overrides` and yarn
 * reads `resolutions`; consumers on those managers mirror this entry there —
 * the init notice says so rather than emitting syntax this repo has not
 * verified.
 *
 * Without it, `@pattern-stack/frontend-patterns` keeps its own bundled
 * `@tanstack/db` and the emitted collections do not type-check (FE-0, #620).
 */
export const FRONTEND_DEP_OVERRIDES = {
	'@tanstack/db': '$@tanstack/db',
} as const;

export type FrontendDepOverrides = typeof FRONTEND_DEP_OVERRIDES;
