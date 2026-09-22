/**
 * Pattern Registry — library + app pattern storage and discovery.
 *
 * Three stores keyed by pattern name:
 *   - `LIBRARY_PATTERNS` — seeded by the codegen package itself when the
 *     `src/patterns/library/*` barrel imports execute. Consumers never
 *     list these in `codegen.config.yaml patterns:`.
 *   - `APP_PATTERNS`     — populated by `loadAppPatterns()` from a
 *     consumer-supplied glob set (default `<backend_src>/patterns/*.pattern.ts`).
 *   - `ORCHESTRATION_APP_PATTERNS` — populated by the same loader,
 *     routed by `kind: 'orchestration'` (ADR-032). No library
 *     orchestration patterns ship in Phase 3-1.
 *
 * Both stores hold **entity-attached** patterns — domain (ADR-031) and
 * capability (ADR-041) — because both are resolved the same way: by a name in
 * an entity's `pattern:` / `patterns:` list. One store also means a capability
 * that reuses a domain pattern's name hits the existing duplicate-name check
 * for free.
 *
 * A name is unique across BOTH stores: an app pattern that reuses a library
 * pattern's name is a load error and is not registered (ADR-041.1). There is
 * no shadowing — a project cannot silently replace `Actor` or `Integrated`
 * with its own definition, and a library release that adds a name a project
 * already uses surfaces as that error rather than as a quiet swap.
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
	isCapabilityPattern,
	isOrchestrationPattern,
	isPatternDefinition,
	type AnyPatternDefinition,
	type CapabilityPatternDefinition,
	type EntityPatternDefinition,
	type OrchestrationPatternDefinition,
	type PatternDefinition,
} from './pattern-definition.js';

// ============================================================================
// Stores
// ============================================================================

const LIBRARY_PATTERNS: Map<string, EntityPatternDefinition> = new Map();
const APP_PATTERNS: Map<string, EntityPatternDefinition> = new Map();

/**
 * Orchestration patterns (ADR-032). Library never ships orchestration
 * patterns in Phase 3-1 — only the app-pattern map exists for this kind.
 * If a library-shipped orchestration pattern ever lands, add a parallel
 * `LIBRARY_ORCHESTRATION_PATTERNS` map; for now keep storage minimal.
 */
const ORCHESTRATION_APP_PATTERNS: Map<string, OrchestrationPatternDefinition> =
	new Map();

/**
 * Every pattern must contribute *something*. A pattern that contributes
 * nothing would generate no useful output and almost certainly indicates
 * a typo or an unfinished definition.
 *
 * What counts differs by kind, because the two kinds reach generated code by
 * different routes (ADR-041 §3):
 *
 *   - **domain** — columns, or one of the two inheritable class references.
 *   - **capability** — columns, a repository `mixin`, or a `forwarderMethods`
 *     vocabulary.
 */
function assertHasContribution(def: EntityPatternDefinition): void {
	const hasColumns = Array.isArray(def.columns) && def.columns.length > 0;

	if (isCapabilityPattern(def)) {
		assertCapabilityShape(def);
		const hasMixin = typeof def.mixin === 'string' && def.mixin.length > 0;
		const hasForwarders =
			Array.isArray(def.forwarderMethods) && def.forwarderMethods.length > 0;
		// `columns` alone does not count: codegen never emits a pattern's
		// columns (they feed the collision check only), so a columns-only
		// capability would layer nothing at all (#688).
		if (!hasMixin && !hasForwarders) {
			throw new Error(
				`Capability pattern '${def.name}' contributes nothing — at least one of ` +
					'`mixin` or `forwarderMethods` is required (`columns` are collision-checked, ' +
					'never emitted).',
			);
		}
		return;
	}

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
 * Shape rules specific to `kind: 'capability'` (ADR-041 §3).
 *
 * A capability is *layered*, never inherited, so declaring an inheritable base
 * on one is a contradiction rather than a harmless extra field — codegen would
 * have no place to emit it, and the author would silently get nothing. The
 * mixin pair is all-or-nothing for the same reason: a name codegen cannot
 * import, or an import with no name to call, emits nothing.
 */
function assertCapabilityShape(def: CapabilityPatternDefinition): void {
	// A hand-authored capability can carry these keys even though the interface
	// forbids them (app patterns arrive from a dynamic import, unchecked), which
	// is exactly the case worth catching.
	const stray = def as CapabilityPatternDefinition &
		Partial<Pick<PatternDefinition, 'repositoryClass' | 'serviceClass'>>;
	const inheritable = (
		[
			['repositoryClass', stray.repositoryClass],
			['serviceClass', stray.serviceClass],
		] as const
	).filter(([, value]) => typeof value === 'string' && value.length > 0);

	if (inheritable.length > 0) {
		throw new Error(
			`Capability pattern '${def.name}' declares ` +
				inheritable.map(([key]) => `\`${key}\``).join(' and ') +
				' — a capability is layered, never inherited. Drop it, or declare the ' +
				"pattern as `kind: 'domain'` if it really is a spine base.",
		);
	}

	const hasMixin = typeof def.mixin === 'string' && def.mixin.length > 0;
	const hasMixinImport =
		typeof def.mixinImport === 'string' && def.mixinImport.length > 0;
	if (hasMixin !== hasMixinImport) {
		throw new Error(
			`Capability pattern '${def.name}' declares ` +
				(hasMixin ? '`mixin` without `mixinImport`' : '`mixinImport` without `mixin`') +
				' — codegen needs both to emit the `extends` clause.',
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
export function registerLibraryPattern(def: EntityPatternDefinition): void {
	assertHasContribution(def);
	LIBRARY_PATTERNS.set(def.name, def);
}

// ============================================================================
// Lookup
// ============================================================================

/**
 * Resolve an **entity-attached** pattern by name — domain or capability.
 * Names are unique across library and app patterns (`loadAppPatterns` refuses
 * an app pattern that reuses a library name), so the lookup order below never
 * decides between two definitions.
 *
 * Callers that need the two apart narrow with `isCapabilityPattern()` /
 * `isDomainPattern()`, or call `composePatterns()` (`./compose.js`), which does
 * the partition and the spine selection in one place.
 *
 * Orchestration patterns live in a disjoint store; use
 * `getOrchestrationPattern()` to look those up. That surface is
 * intentionally separate (ADR-032 Decision 8) — it is not entity-attached at
 * all, so no entity-side caller should have to narrow it away.
 */
export function getPattern(name: string): EntityPatternDefinition | undefined {
	return APP_PATTERNS.get(name) ?? LIBRARY_PATTERNS.get(name);
}

/**
 * Return every registered entity-attached pattern name (library + app), sorted for
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

/** One app-pattern file the loader could not register. */
export interface AppPatternLoadError {
	/** The file (relative to `cwd`), or the glob when expansion failed */
	file: string;
	/** Human-readable reason; names the file too, for callers that print it alone */
	message: string;
}

export interface LoadAppPatternsResult {
	/** Pattern names that were successfully registered, sorted */
	loaded: string[];
	/** One error per file (or glob) that registered nothing it declared */
	errors: AppPatternLoadError[];
}

/**
 * Expand every glob in `manifestPaths` relative to `cwd`, dynamic-import
 * each matching file, and register every exported value that passes
 * `isPatternDefinition()`. Exports whose name ends in `Pattern` and
 * pass the shape check are registered; other exports are ignored so
 * that files can export helper values alongside their pattern.
 *
 * The loader never throws: import failures, a pattern that fails the
 * "at-least-one-contribution" check, and name collisions are collected and
 * returned, each naming its file. What an error means is the caller's call —
 * `entity new` rejects the run on any (JOBS-2: a partial pattern set would
 * regenerate the orchestration barrel without the lost module).
 *
 * Idempotent: calling twice with the same arguments leaves `APP_PATTERNS`
 * in the same state as calling once.
 */
export async function loadAppPatterns(
	manifestPaths: string[],
	cwd: string,
): Promise<LoadAppPatternsResult> {
	const loaded = new Set<string>();
	const errors: AppPatternLoadError[] = [];

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
			errors.push({
				file: raw,
				message: `Failed to expand pattern glob '${raw}': ${stringifyError(err)}`,
			});
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
						errors.push({
							file: relPath(filePath, cwd),
							message: `Orchestration pattern '${orch.name}' in ${relPath(filePath, cwd)} is invalid: ${stringifyError(assertErr)}`,
						});
						continue;
					}
					const existingOrch = ORCHESTRATION_APP_PATTERNS.get(orch.name);
					if (existingOrch && existingOrch !== orch) {
						errors.push({
							file: relPath(filePath, cwd),
							message: `Orchestration pattern '${orch.name}' in ${relPath(filePath, cwd)} duplicates a previously loaded orchestration pattern. Pattern names must be unique.`,
						});
						continue;
					}
					ORCHESTRATION_APP_PATTERNS.set(orch.name, orch);
					loaded.add(orch.name);
				} else {
					try {
						assertHasContribution(val);
					} catch (assertErr) {
						errors.push({
							file: relPath(filePath, cwd),
							message: `Pattern '${val.name}' in ${relPath(filePath, cwd)} is invalid: ${stringifyError(assertErr)}`,
						});
						continue;
					}
					// ADR-041.1: one name, one definition — across the library
					// boundary too. Shadowing a library pattern was possible (the
					// lookup is app-first) and silent; it is now the same error
					// as two app patterns sharing a name.
					if (LIBRARY_PATTERNS.has(val.name)) {
						errors.push({
							file: relPath(filePath, cwd),
							message: `Pattern '${val.name}' in ${relPath(filePath, cwd)} reuses the name of a library pattern. Pattern names must be unique across library and app patterns — rename it.`,
						});
						continue;
					}
					const existingDom = APP_PATTERNS.get(val.name);
					if (existingDom && existingDom !== val) {
						errors.push({
							file: relPath(filePath, cwd),
							message: `Pattern '${val.name}' in ${relPath(filePath, cwd)} duplicates a previously loaded app pattern. Pattern names must be unique.`,
						});
						continue;
					}
					APP_PATTERNS.set(val.name, val);
					loaded.add(val.name);
				}
			}
		} catch (err) {
			errors.push({
				file: relPath(filePath, cwd),
				message: `Failed to load pattern file '${relPath(filePath, cwd)}': ${stringifyError(err)}`,
			});
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
