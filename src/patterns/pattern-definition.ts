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
 * Two pattern kinds share this surface:
 *   - **domain** (default; ADR-031) — `PatternDefinition`. Contributes
 *     repository/service base classes, columns, behaviors to entities that
 *     declare `pattern:`/`patterns:` in YAML.
 *   - **orchestration** (ADR-032) — `OrchestrationPatternDefinition`. Declares
 *     a DI registry + optional dispatcher scaffold. Not entity-attached;
 *     codegen emits a NestJS module under `src/orchestration/` instead.
 *
 * See `docs/adrs/ADR-031-app-defined-patterns.md` §"Decision 1" for the
 * domain binding surface and `docs/adrs/ADR-032-orchestration-patterns.md`
 * for the orchestration kind.
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
 * Discriminator for the two pattern shapes. Default is `"domain"` to preserve
 * Phase 1 (ADR-031) behaviour — every existing PatternDefinition without a
 * `kind` field continues to register as a domain pattern.
 */
export type PatternKind = 'domain' | 'orchestration';

/**
 * The full pattern metadata record. Every `definePattern({...})` call
 * returns a value of this shape; the library and consumer registries
 * store these and look them up by `name`.
 */
export interface PatternDefinition<TConfig = unknown> {
	/** Unique name used in YAML — e.g. `pattern: Integrated` */
	name: string;

	/**
	 * ADR-032: defaults to `"domain"`. Phase 3 adds `"orchestration"` as a
	 * disjoint shape (see `OrchestrationPatternDefinition`). Domain
	 * `PatternDefinition` instances must omit this field or set it to
	 * `"domain"`; the loader routes orchestration values to a separate map.
	 */
	kind?: 'domain';

	/**
	 * Built-in patterns this extends, by name. Phase 1 supports single-depth
	 * chains only — a pattern may `extends: ['Integrated']` but the transitive
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
	 * (e.g. `@shared/base-classes/integrated-entity-repository`); app patterns
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
 *
 * This function is intentionally **kind-agnostic** — both
 * `PatternDefinition` (domain) and `OrchestrationPatternDefinition`
 * (orchestration) pass. The discriminator routing happens in the loader
 * via `isOrchestrationPattern()`/`isDomainPattern()`.
 */
export function isPatternDefinition(val: unknown): val is PatternDefinition {
	return (
		typeof val === 'object' &&
		val !== null &&
		'name' in val &&
		typeof (val as { name: unknown }).name === 'string'
	);
}

// ============================================================================
// Orchestration kind (ADR-032)
// ============================================================================

/**
 * One registry's declarative shape. ADR-032 §"The Proposal".
 *
 * Phase 3-1 records this; Phase 3-2 codegen reads it to emit token files,
 * provider blocks, and dispatcher overload signatures. Phase 3-1 validates
 * only what is statically checkable from this record alone — see
 * `validate-orchestration.ts` for the rules and their deferral notes.
 */
export interface OrchestrationRegistrySpec {
	/**
	 * Identifier for co-keyed sibling registries (ADR-032 Phase 3-2/3, O-1).
	 *
	 * The PRIMARY registry never carries a `name` — its tokens / methods are
	 * derived from the pattern name alone (`${PATTERN_CONST}_REGISTRY`,
	 * `select(...)`). Each co-keyed sibling MUST carry an explicit `name`
	 * which the emitter uppercases for the token suffix and PascalCases for
	 * the dispatcher method suffix:
	 *
	 *   `coKeyedRegistries: [{ name: 'auth', valueType: 'IAuthStrategy' ... }]`
	 *   ⇒ `CRM_PORTS_AUTH_REGISTRY` token + `selectAuth(...)` method.
	 *
	 * No auto-stripping of "I" prefix or "Strategy/Port/Adapter/Provider"
	 * suffixes — authors pick what reads right.
	 */
	name?: string;
	/**
	 * Type alias the consumer's tsconfig resolves (e.g. `"CrmAdapterDomain"`).
	 * Phase 3-1 stores this string verbatim. Resolution that the path actually
	 * imports a concrete TS enum is deferred to Phase 3-2 emission, where
	 * codegen will need to read the consumer's source tree.
	 */
	keyType: string;
	/**
	 * Module specifier the emitter writes into `import type { keyType } from
	 * '<keyTypeImport>'`. Required at Phase 3-2 emission; the generator emits
	 * `pattern_missing_import_path` if absent. (ADR-032 Phase 3-2 §3.4 / O-3.)
	 */
	keyTypeImport?: string;
	/** Same shape as `keyType` — the registry's value-type interface ref. */
	valueType: string;
	/** Module specifier for `valueType` import. See `keyTypeImport`. */
	valueTypeImport?: string;
	entries: ReadonlyArray<{
		/** Stable string key — must be unique within this registry. */
		key: string;
		/**
		 * Concrete provider class name (NOT a DI token string). Codegen will
		 * import this and use it as the constructor injectable.
		 * Phase 3-1 records it; Phase 3-2 verifies it resolves.
		 */
		provider: string;
		/** Module specifier for `provider` import. See `keyTypeImport`. */
		providerImport?: string;
	}>;
}

/**
 * Orchestration pattern — declarative DI registry + optional dispatcher
 * scaffold. ADR-032 §"The Proposal" + Decisions 1-8.
 *
 * Disjoint from `PatternDefinition` (domain): no columns, no
 * repository/service base class, no entity-level patternConfig. Composition
 * with domain patterns happens only at the DI layer in the consumer's
 * generated code, not in entity YAML.
 */
export interface OrchestrationPatternDefinition {
	name: string;
	kind: 'orchestration';
	/** Primary registry (always present). */
	registry: OrchestrationRegistrySpec;
	/**
	 * Sibling registries that share the primary registry's key space.
	 * ADR-032 Decision 2 — co-keyed groups are a first-class field.
	 * Validator enforces matching `keyType` across the group.
	 */
	coKeyedRegistries?: ReadonlyArray<OrchestrationRegistrySpec>;
	/** Optional dispatcher scaffold spec (ADR-032 Decision 4 + 5). */
	dispatcher?: {
		/** Class name to emit (e.g. `"CrmPortsDispatcher"`). */
		className: string;
		/**
		 * Method name the consumer overrides in their subclass to fill the
		 * assembly body (ADR-032 Decision 5).
		 */
		assemblySlot: string;
	};
	/** One-line description for help output and error messages. */
	description?: string;
}

/** Union for callers that need to handle both shapes. */
export type AnyPatternDefinition =
	| PatternDefinition
	| OrchestrationPatternDefinition;

export function isOrchestrationPattern(
	def: AnyPatternDefinition,
): def is OrchestrationPatternDefinition {
	return (def as { kind?: PatternKind }).kind === 'orchestration';
}

export function isDomainPattern(
	def: AnyPatternDefinition,
): def is PatternDefinition {
	return !isOrchestrationPattern(def);
}

/**
 * Identity function that returns its argument unchanged — orchestration
 * counterpart to `definePattern()`. The body is trivial on purpose; the
 * point is to give TypeScript a hook so consumer fixtures get full
 * compile-time checking against `OrchestrationPatternDefinition`.
 */
export function defineOrchestrationPattern(
	def: OrchestrationPatternDefinition,
): OrchestrationPatternDefinition {
	return def;
}
