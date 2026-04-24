/**
 * Pattern Registry — library + app pattern storage and discovery.
 *
 * Three stores keyed by pattern name:
 *   - `LIBRARY_PATTERNS` — seeded by the codegen package itself when the
 *     `src/patterns/library/*` barrel imports execute. Consumers never
 *     list these in `codegen.config.yaml patterns:`. Domain only.
 *   - `APP_PATTERNS`     — populated by `loadAppPatterns()` from a
 *     consumer-supplied glob set (default `src/patterns/*.pattern.ts`).
 *     Domain only.
 *   - `ORCHESTRATION_APP_PATTERNS` — populated by the same loader,
 *     routed by `kind: 'orchestration'` (ADR-032). No library
 *     orchestration patterns ship in Phase 3-1.
 *
 * `getPattern()` checks app patterns first so a consumer could, in
 * principle, shadow a library pattern by using the same `name`. That's
 * not a documented feature, but nothing in the API prevents it.
 *
 * The Hygen subprocess (`src/cli/shared/hygen.ts:64`) reloads this module
 * independently — it has no shared memory with the CLI process. Both
 * loads are deterministic, side-effect-free reads of the same files, so
 * the registry contents are identical across processes. The registry
 * test suite asserts this determinism explicitly.
 *
 * See `docs/adrs/ADR-031-app-defined-patterns.md` §"Decision 5" and
 * `docs/specs/app-defined-patterns-implementation.md` §3.
 */

import { glob } from 'glob';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	isOrchestrationPattern,
	isPatternDefinition,
	type AnyPatternDefinition,
	type OrchestrationPatternDefinition,
	type PatternDefinition,
} from './pattern-definition.js';

// ============================================================================
// Stores
// ============================================================================

const LIBRARY_PATTERNS: Map<string, PatternDefinition> = new Map();
const APP_PATTERNS: Map<string, PatternDefinition> = new Map();

/**
 * Orchestration patterns (ADR-032). Library never ships orchestration
 * patterns in Phase 3-1 — only the app-pattern map exists for this kind.
 * If a library-shipped orchestration pattern ever lands, add a parallel
 * `LIBRARY_ORCHESTRATION_PATTERNS` map; for now keep storage minimal.
 */
const ORCHESTRATION_APP_PATTERNS: Map<string, OrchestrationPatternDefinition> =
	new Map();

/**
 * Every pattern must contribute *something* — either at least one column
 * or at least one of the two class references. A pattern that contributes
 * nothing would generate no useful output and almost certainly indicates
 * a typo or an unfinished definition.
 */
function assertHasContribution(def: PatternDefinition): void {
	const hasColumns = Array.isArray(def.columns) && def.columns.length > 0;
	const hasRepo =
		typeof def.repositoryClass === 'string' && def.repositoryClass.length > 0;
	const hasService =
		typeof def.serviceClass === 'string' && def.serviceClass.length > 0;

	if (!hasColumns && !hasRepo && !hasService) {
		throw new Error(
			`Pattern '${def.name}' contributes nothing — at least one of ` +
				'`columns`, `repositoryClass`, or `serviceClass` is required.',
		);
	}
}

/**
 * Orchestration counterpart to `assertHasContribution`. An orchestration
 * pattern's minimum contribution is one registry with at least one entry —
 * a registry with zero entries would emit a token + module that nothing
 * resolves to, almost certainly a typo. Detailed entry validation
 * (duplicate keys, malformed entries, co-keyed mismatches) lives in the
 * project-level validator so loader behaviour stays symmetrical with the
 * domain side: load is non-throwing for content-level issues, validator
 * is the single authoritative reporter.
 */
function assertOrchestrationContribution(
	def: OrchestrationPatternDefinition,
): void {
	if (!def.registry || typeof def.registry !== 'object') {
		throw new Error(
			`Orchestration pattern '${def.name}' is missing a 'registry' field.`,
		);
	}
	if (
		typeof def.registry.keyType !== 'string' ||
		def.registry.keyType.length === 0
	) {
		throw new Error(
			`Orchestration pattern '${def.name}' registry.keyType must be a non-empty string.`,
		);
	}
	if (
		typeof def.registry.valueType !== 'string' ||
		def.registry.valueType.length === 0
	) {
		throw new Error(
			`Orchestration pattern '${def.name}' registry.valueType must be a non-empty string.`,
		);
	}
	if (
		!Array.isArray(def.registry.entries) ||
		def.registry.entries.length === 0
	) {
		throw new Error(
			`Orchestration pattern '${def.name}' registry.entries must contain at least one entry.`,
		);
	}
}

// ============================================================================
// Library pattern registration
// ============================================================================

/**
 * Insert a library pattern into the registry. Called once by each
 * `src/patterns/library/*.pattern.ts` file via the barrel. Re-registering
 * the same name overwrites the previous value silently; this is
 * intentional for hot-reload scenarios but should not happen in normal
 * use.
 */
export function registerLibraryPattern(def: PatternDefinition): void {
	assertHasContribution(def);
	LIBRARY_PATTERNS.set(def.name, def);
}

// ============================================================================
// Lookup
// ============================================================================

/**
 * Resolve a **domain** pattern by name. App patterns shadow library
 * patterns with the same name — useful in principle but not a documented
 * feature.
 *
 * Orchestration patterns live in a disjoint store; use
 * `getOrchestrationPattern()` to look those up. The two surfaces are
 * intentionally separate (ADR-032 Decision 8) so callers don't have to
 * narrow the result on every callsite.
 */
export function getPattern(name: string): PatternDefinition | undefined {
	return APP_PATTERNS.get(name) ?? LIBRARY_PATTERNS.get(name);
}

/**
 * Return every registered domain pattern name (library + app), sorted for
 * deterministic output. The two-process determinism test relies on this
 * ordering being stable across processes. Orchestration names are NOT
 * included — see `getOrchestrationPatternNames()`.
 */
export function getAllPatternNames(): string[] {
	const set = new Set<string>([
		...LIBRARY_PATTERNS.keys(),
		...APP_PATTERNS.keys(),
	]);
	return [...set].sort();
}

/** Library-only view — mainly for debugging and tests. */
export function getLibraryPatternNames(): string[] {
	return [...LIBRARY_PATTERNS.keys()].sort();
}

/** App-only view — mainly for debugging and tests. */
export function getAppPatternNames(): string[] {
	return [...APP_PATTERNS.keys()].sort();
}

// ============================================================================
// Orchestration accessors (ADR-032)
// ============================================================================

/** Resolve an orchestration pattern by name. */
export function getOrchestrationPattern(
	name: string,
): OrchestrationPatternDefinition | undefined {
	return ORCHESTRATION_APP_PATTERNS.get(name);
}

/** Sorted list of orchestration pattern names. */
export function getOrchestrationPatternNames(): string[] {
	return [...ORCHESTRATION_APP_PATTERNS.keys()].sort();
}

/**
 * Every registered orchestration pattern, sorted by name. The
 * project-level validator iterates this list in one place so issue
 * ordering is stable across processes.
 */
export function getAllOrchestrationPatterns(): OrchestrationPatternDefinition[] {
	return getOrchestrationPatternNames().map(
		(n) => ORCHESTRATION_APP_PATTERNS.get(n)!,
	);
}

// ============================================================================
// App pattern discovery
// ============================================================================

export interface LoadAppPatternsResult {
	/** Pattern names that were successfully registered, sorted */
	loaded: string[];
	/** One human-readable error per failed file import */
	errors: string[];
}

/**
 * Expand every glob in `manifestPaths` relative to `cwd`, dynamic-import
 * each matching file, and register every exported value that passes
 * `isPatternDefinition()`. Exports whose name ends in `Pattern` and
 * pass the shape check are registered; other exports are ignored so
 * that files can export helper values alongside their pattern.
 *
 * Import failures are non-fatal — the error is collected and returned
 * so the CLI can surface it without breaking generation of unrelated
 * entities. A pattern that fails the "at-least-one-contribution" check
 * surfaces here as an error too.
 *
 * Idempotent: calling twice with the same arguments leaves `APP_PATTERNS`
 * in the same state as calling once.
 */
export async function loadAppPatterns(
	manifestPaths: string[],
	cwd: string,
): Promise<LoadAppPatternsResult> {
	const loaded = new Set<string>();
	const errors: string[] = [];

	// Collect + dedupe absolute file paths across every glob pattern so
	// a file matched by two globs is imported once.
	const files = new Set<string>();
	for (const raw of manifestPaths) {
		try {
			const expanded = await glob(raw, { cwd, absolute: true, nodir: true });
			for (const filePath of expanded) {
				files.add(filePath);
			}
		} catch (err) {
			errors.push(
				`Failed to expand pattern glob '${raw}': ${stringifyError(err)}`,
			);
		}
	}

	// Sort so dynamic-import order is deterministic across processes —
	// the Hygen subprocess relies on this to produce the same registry
	// as the CLI.
	const sortedFiles = [...files].sort();

	for (const filePath of sortedFiles) {
		try {
			// `pathToFileURL` is required for absolute-path dynamic imports on
			// Windows and makes the behavior identical on macOS/Linux.
			const mod = (await import(pathToFileURL(filePath).href)) as Record<
				string,
				unknown
			>;
			for (const [key, val] of Object.entries(mod)) {
				if (!key.endsWith('Pattern')) continue;
				if (!isPatternDefinition(val)) continue;

				// Route on `kind`. Domain (default) and orchestration land in
				// disjoint maps; same-name collisions within either map are
				// load-time errors (silent overwrite was wrong by CLAUDE.md
				// "architectural correctness" — see ADR-032 §Composition rules
				// row 1).
				if (isOrchestrationPattern(val as unknown as AnyPatternDefinition)) {
					const orch = val as unknown as OrchestrationPatternDefinition;
					try {
						assertOrchestrationContribution(orch);
					} catch (assertErr) {
						errors.push(
							`Orchestration pattern '${orch.name}' in ${relPath(filePath, cwd)} is invalid: ${stringifyError(assertErr)}`,
						);
						continue;
					}
					const existingOrch = ORCHESTRATION_APP_PATTERNS.get(orch.name);
					if (existingOrch && existingOrch !== orch) {
						errors.push(
							`Orchestration pattern '${orch.name}' in ${relPath(filePath, cwd)} duplicates a previously loaded orchestration pattern. Pattern names must be unique.`,
						);
						continue;
					}
					ORCHESTRATION_APP_PATTERNS.set(orch.name, orch);
					loaded.add(orch.name);
				} else {
					try {
						assertHasContribution(val);
					} catch (assertErr) {
						errors.push(
							`Pattern '${val.name}' in ${relPath(filePath, cwd)} is invalid: ${stringifyError(assertErr)}`,
						);
						continue;
					}
					const existingDom = APP_PATTERNS.get(val.name);
					if (existingDom && existingDom !== val) {
						errors.push(
							`Pattern '${val.name}' in ${relPath(filePath, cwd)} duplicates a previously loaded app pattern. Pattern names must be unique.`,
						);
						continue;
					}
					APP_PATTERNS.set(val.name, val);
					loaded.add(val.name);
				}
			}
		} catch (err) {
			errors.push(
				`Failed to load pattern file '${relPath(filePath, cwd)}': ${stringifyError(err)}`,
			);
		}
	}

	return {
		loaded: [...loaded].sort(),
		errors,
	};
}

// ============================================================================
// Test-only reset
// ============================================================================

/**
 * Clear every registered app pattern and, optionally, library patterns too.
 *
 * Intended for unit tests that build isolated scenarios on top of a clean
 * registry. Not exported from the barrel — tests import it directly from
 * `./registry.js`.
 */
export function _resetRegistryForTests(
	opts: { includeLibrary?: boolean } = {},
): void {
	APP_PATTERNS.clear();
	ORCHESTRATION_APP_PATTERNS.clear();
	if (opts.includeLibrary) {
		LIBRARY_PATTERNS.clear();
	}
}

// ============================================================================
// Helpers
// ============================================================================

function stringifyError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function relPath(abs: string, cwd: string): string {
	try {
		return path.relative(cwd, abs) || abs;
	} catch {
		return abs;
	}
}
