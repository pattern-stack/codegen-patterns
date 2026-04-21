/**
 * Pattern Definition — pure metadata record returned by an identity function.
 *
 * `definePattern()` is the registration artifact for both library-shipped and
 * app-defined patterns. It carries only names + import paths for the classes
 * a generated entity should extend — never the class constructors themselves.
 * This keeps the codegen pipeline free of TS class-evaluation cost and avoids
 * `reflect-metadata`, which lets the Hygen subprocess cheaply rebuild the
 * registry (see `src/cli/shared/hygen.ts` — the registry loads twice per
 * `entity new` invocation).
 *
 * See `docs/adrs/ADR-031-app-defined-patterns.md` §"Decision 1" for the
 * binding surface and `docs/specs/app-defined-patterns-implementation.md` §1
 * for the file-by-file rationale.
 */

import type { ZodSchema } from 'zod';

/**
 * A column a pattern contributes to every entity that declares it.
 *
 * Column-level conflicts between patterns, between a pattern and an
 * entity-declared field, or between a pattern and a behavior-contributed
 * field are codegen-time hard errors; see
 * `src/patterns/validate-composition.ts`.
 */
export interface PatternColumnContribution {
	/** snake_case column name — matches the database column */
	name: string;
	/** Drizzle column type string, e.g. "varchar(255)" or "text" */
	type: string;
}

/**
 * The full pattern metadata record. Every `definePattern({...})` call
 * returns a value of this shape; the library and consumer registries
 * store these and look them up by `name`.
 */
export interface PatternDefinition<TConfig = unknown> {
	/** Unique name used in YAML — e.g. `pattern: Synced` */
	name: string;

	/**
	 * Built-in patterns this extends, by name. Phase 1 supports single-depth
	 * chains only — a pattern may `extends: ['Synced']` but the transitive
	 * chain is not yet resolved. Multi-depth inheritance is deferred until
	 * a real consumer asks.
	 */
	extends?: string[];

	/** Constructor name codegen emits in the generated repo's `extends` clause */
	repositoryClass?: string;
	/** Constructor name codegen emits in the generated service's `extends` clause */
	serviceClass?: string;

	/**
	 * Fully-qualified TypeScript path alias the consumer's tsconfig resolves.
	 * Library patterns use the consumer-installed runtime base class path
	 * (e.g. `@shared/base-classes/synced-entity-repository`); app patterns
	 * use whatever alias the consumer has configured (e.g. `@/patterns/...`).
	 */
	repositoryImport?: string;
	/** Same as `repositoryImport` but for the service base class */
	serviceImport?: string;

	/**
	 * Documentation-only method-signature strings emitted as comments in the
	 * generated repo. Exist purely so app authors reading the generated file
	 * see what their concrete class inherits without jumping to the base.
	 */
	repositoryInheritedMethods?: string[];
	/** Same as `repositoryInheritedMethods` but for the service base class */
	serviceInheritedMethods?: string[];

	/**
	 * Columns this pattern adds to every entity that declares it. Used by
	 * the composition validator to detect column-name collisions.
	 */
	columns?: PatternColumnContribution[];

	/**
	 * Behaviors this pattern implicitly enables. Entity YAML need not
	 * re-declare them; duplicates across patterns are silent-deduped.
	 */
	impliedBehaviors?: string[];

	/**
	 * Zod schema that validates the per-entity `config:` block for this
	 * pattern at parse time. When absent, entities may not supply a `config:`
	 * entry for this pattern and codegen emits no `patternConfig` property.
	 */
	configSchema?: ZodSchema<TConfig>;

	/** One-line description for codegen help output and error messages */
	description?: string;
}

/**
 * Identity function that returns its argument unchanged. The body is trivial
 * on purpose — the whole point is to give TypeScript a hook for generic
 * inference on `TConfig` while leaving the runtime value a plain object
 * registered by the codegen loader.
 */
export function definePattern<TConfig = unknown>(
	def: PatternDefinition<TConfig>,
): PatternDefinition<TConfig> {
	return def;
}

/**
 * Shape check for values produced by `import()`ing an app pattern file.
 * The registry loader runs this on every exported value it finds; only
 * values that pass are registered.
 *
 * We keep this deliberately loose — a `name` string is the whole
 * requirement — because a pattern that contributes neither columns nor
 * class references is still a *valid* identity pattern (e.g. `BasePattern`
 * exists to anchor the `extends` chain without contributing anything).
 * Stricter shape rules belong in the registry's "at-least-one-contribution"
 * check, not here.
 */
export function isPatternDefinition(val: unknown): val is PatternDefinition {
	return (
		typeof val === 'object' &&
		val !== null &&
		'name' in val &&
		typeof (val as { name: unknown }).name === 'string'
	);
}
