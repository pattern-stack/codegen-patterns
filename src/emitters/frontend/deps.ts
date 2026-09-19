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
 * three drift onto three different `@tanstack/db` versions, alongside the
 * direct `@tanstack/db` — four copies, four type identities, and
 * `createCollection(electricCollectionOptions(...))` (what `emit-collections.ts`
 * writes) stopped compiling with a `sync.sync` mismatch naming two of them.
 * Measured in `docs/specs/FE-0.md`; the frontend analogue of the
 * dual-`drizzle-orm` hazard DRZ-2 fixed.
 *
 * So the four `@tanstack/db`-bearing packages are pinned to the set that agrees
 * ({@link FRONTEND_LOCKSTEP_DEPS}). **The pins are what keep the tree at one
 * copy** — `just test-smoke-frontend` fails with carets and passes with pins.
 * `@pattern-stack/frontend-patterns` declares `@tanstack/db@^0.5.11` as an
 * ordinary dependency, which `0.5.33` satisfies, so it dedupes onto the pin by
 * itself. {@link FRONTEND_DEP_OVERRIDES} is belt-and-braces on top (see there).
 *
 * Moving the set forward is a deliberate, one-commit change: pick another row
 * of the lockstep table and let `just test-smoke-frontend` prove the emitted
 * tree still compiles.
 *
 * See docs/specs/2026-06-04-frontend-pipeline-rebuild.md → "Version pairing",
 * and docs/specs/FE-0.md.
 */

/**
 * The lockstep set — change these four together, never one of them. Split out
 * so `project init` can hold an existing consumer `package.json` to it
 * (`mergeFrontendDeps` corrects these four; every other entry is the
 * consumer's choice).
 */
export const FRONTEND_LOCKSTEP_DEPS = {
	'@tanstack/db': '0.5.33',
	'@tanstack/react-db': '0.1.77',
	'@tanstack/electric-db-collection': '0.2.41',
	'@tanstack/query-db-collection': '1.0.30',
} as const;

export const FRONTEND_EMITTED_DEPS = {
	// The sync layer (`createEntityHooks` / `createStore`). Stays on the alpha
	// line: the `1.0.0` published on npm ships no `dist/sync` at all and is not
	// dist-tagged `latest` (docs/specs/FE-REL.md §2.1).
	'@pattern-stack/frontend-patterns': '^0.2.0-alpha.18',
	// `snakeCamelMapper`, imported by every emitted electric collection. The
	// range `@tanstack/electric-db-collection@0.2.41` itself declares, so no
	// second copy. Previously undeclared and resolved only by hoisting (FE-0).
	'@electric-sql/client': '^1.5.12',
	...FRONTEND_LOCKSTEP_DEPS,
	// No `@tanstack/db` in its tree, so a caret is safe here.
	'@tanstack/react-query': '^5.0.0',
} as const;

export type FrontendEmittedDeps = typeof FRONTEND_EMITTED_DEPS;

/**
 * Package-manager overrides the generated frontend `package.json` must carry.
 *
 * `$@tanstack/db` resolves every transitive copy to the direct dependency
 * declared in {@link FRONTEND_EMITTED_DEPS} — so the version lives in exactly
 * one place. pnpm reads `pnpm.overrides` and yarn reads `resolutions`;
 * consumers on those managers mirror this entry there — the init notice says
 * so rather than emitting syntax this repo has not verified.
 *
 * **Belt-and-braces, not load-bearing today.** Measured against the pinned set
 * (FE-0 §4): bun and npm both install exactly one `@tanstack/db` (0.5.33) with
 * AND without this entry — the lockstep pins alone are what collapse the tree,
 * and they are what `just test-smoke-frontend` proves. The override is kept
 * because it costs nothing and closes the cases the pins cannot: a future
 * `@pattern-stack/frontend-patterns` whose `@tanstack/db` range excludes the
 * pin, or a stale lockfile still holding a nested copy.
 */
export const FRONTEND_DEP_OVERRIDES = {
	'@tanstack/db': '$@tanstack/db',
} as const;

export type FrontendDepOverrides = typeof FRONTEND_DEP_OVERRIDES;
