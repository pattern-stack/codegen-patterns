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
 *   - **capability** (ADR-041) — `CapabilityPatternDefinition`. Entity-attached
 *     like a domain pattern, but *layered* rather than inherited: it contributes
 *     a repository mixin and/or a small method vocabulary forwarded on the
 *     service. TypeScript allows exactly one base class, so an entity composes
 *     one domain **spine** plus N capabilities.
 *
 * Domain and capability patterns share one registry store — both are resolved
 * by a name in an entity's `pattern:` / `patterns:` list. Orchestration lives in
 * a disjoint store; it is not entity-attached.
 *
 * See `docs/adrs/ADR-031-app-defined-patterns.md` §"Decision 1" for the
 * domain binding surface, `docs/adrs/ADR-032-orchestration-patterns.md`
 * for the orchestration kind, and
 * `docs/adrs/ADR-041-capability-composition-emission.md` for capabilities.
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
 * Discriminator for the three pattern shapes. Default is `"domain"` to preserve
 * Phase 1 (ADR-031) behaviour — every existing PatternDefinition without a
 * `kind` field continues to register as a domain pattern.
 */
export type PatternKind = 'domain' | 'orchestration' | 'capability';

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
 * This function is intentionally **kind-agnostic** — `PatternDefinition`
 * (domain), `CapabilityPatternDefinition` (capability) and
 * `OrchestrationPatternDefinition` (orchestration) all pass. The discriminator
 * routing happens in the loader via
 * `isOrchestrationPattern()` / `isCapabilityPattern()` / `isDomainPattern()`.
 */
export function isPatternDefinition(val: unknown): val is EntityPatternDefinition {
	return (
		typeof val === 'object' &&
		val !== null &&
		'name' in val &&
		typeof (val as { name: unknown }).name === 'string'
	);
}

// ============================================================================
// Capability kind (ADR-041)
// ============================================================================

/**
 * A pattern that **layers** onto an entity instead of being inherited by it.
 *
 * ADR-041 §3. Single inheritance means an entity can extend exactly one base
 * class — its *spine* (a domain pattern). Everything else a composed entity
 * needs has to arrive some other way, and a capability declares which:
 *
 *   - `mixin` / `mixinImport` — a TS mixin applied to the generated
 *     **repository**'s `extends` clause. The shipped `WithAnalytics`
 *     (`runtime/base-classes/with-analytics.ts`) is the mechanism; write new
 *     ones against `runtime/base-classes/capability-mixin.ts`.
 *   - `forwarderMethods` — the small, codegen-known method vocabulary this
 *     capability contributes. Two jobs, one declaration (charter I1): the
 *     generated **service** forwards each name to the repository, and the
 *     generation-time collision check (ADR-041 §4) reads the same list.
 *
 * A capability never carries `repositoryClass` / `serviceClass` — those make a
 * pattern inheritable, which is precisely what a capability is not.
 */
export interface CapabilityPatternDefinition<TConfig = unknown> {
	/** Unique name used in YAML — e.g. `patterns: [Integrated, Actor]` */
	name: string;

	/** Discriminator. Always `"capability"`. */
	kind: 'capability';

	/**
	 * Mixin function name codegen wraps the repository's base in, e.g.
	 * `WithActor`. Requires `mixinImport`.
	 */
	mixin?: string;

	/**
	 * Module specifier for `mixin`. A library capability authors this as
	 * `@shared/base-classes/…` and codegen rewrites it to the package form in
	 * `runtime: package` mode (ADR-037); an app capability's own alias
	 * (e.g. `@modules/capabilities/…`) passes through untouched.
	 */
	mixinImport?: string;

	/**
	 * Method names this capability contributes to the repository. Each is
	 * emitted as a typed pass-through on the generated service (signatures are
	 * derived from the repository method, never re-declared) and each
	 * participates in the generation-time collision check.
	 *
	 * Viable only for small, known vocabularies — that is the trade ADR-041 §3
	 * makes in exchange for collision detection codegen otherwise cannot do.
	 */
	forwarderMethods?: string[];

	/**
	 * Property on the generated repository that carries this capability's
	 * per-entity `config:` block. Defaults to `<camelCase(name)>Config`
	 * (`Actor` → `actorConfig`). The mixin must declare it — the generated
	 * property is emitted with `override`.
	 *
	 * Only meaningful together with `configSchema`.
	 */
	configProperty?: string;

	/**
	 * Columns the capability's mixin relies on. Declarative only: the
	 * composition validator checks them for name collisions (same rules as a
	 * domain pattern's columns), but codegen never emits them — so they never
	 * count as the capability's contribution; a `mixin` or `forwarderMethods`
	 * is required.
	 */
	columns?: PatternColumnContribution[];

	/** Behaviors this capability implicitly enables. Deduped across patterns. */
	impliedBehaviors?: string[];

	/**
	 * Zod schema for the per-entity `config: { <Name>: {...} }` block. When
	 * present and the entity supplies a block, codegen emits it as
	 * `configProperty` on the repository.
	 */
	configSchema?: ZodSchema<TConfig>;

	/** One-line description for codegen help output and error messages. */
	description?: string;
}

/**
 * Identity function — capability counterpart to `definePattern()`. Trivial on
 * purpose; it exists so consumer files get full compile-time checking.
 */
export function defineCapabilityPattern<TConfig = unknown>(
	def: CapabilityPatternDefinition<TConfig>,
): CapabilityPatternDefinition<TConfig> {
	return def;
}

/**
 * Every pattern an entity can declare in `pattern:` / `patterns:` — the two
 * kinds that share the registry store.
 */
export type EntityPatternDefinition =
	| PatternDefinition
	| CapabilityPatternDefinition;

export function isCapabilityPattern(
	def: AnyPatternDefinition,
): def is CapabilityPatternDefinition {
	return (def as { kind?: PatternKind }).kind === 'capability';
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

/** Union for callers that need to handle every shape. */
export type AnyPatternDefinition =
	| PatternDefinition
	| CapabilityPatternDefinition
	| OrchestrationPatternDefinition;

export function isOrchestrationPattern(
	def: AnyPatternDefinition,
): def is OrchestrationPatternDefinition {
	return (def as { kind?: PatternKind }).kind === 'orchestration';
}

/**
 * A domain pattern is one that contributes an *inheritable* base — the default
 * kind. Checked positively rather than as "not orchestration", because a third
 * kind exists now (ADR-041).
 */
export function isDomainPattern(
	def: AnyPatternDefinition,
): def is PatternDefinition {
	const kind = (def as { kind?: PatternKind }).kind;
	return kind === undefined || kind === 'domain';
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
