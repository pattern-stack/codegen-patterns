/**
 * Domain Analyzer Types
 *
 * Core type definitions for the domain analysis tool.
 */

import type {
	Additivity,
	Agg,
	EntityDefinition,
	MetricDefinition,
} from '../schema/entity-definition.schema';

// The semantic-model vocabulary is declared once, in the Zod schema; these
// re-exports let the parser and emitters name the types without reaching past
// the analyzer's type surface (SEM-1).
export type {
	Additivity,
	Agg,
	DerivedExpr,
	MetricDefinition,
} from '../schema/entity-definition.schema';
import type { RelationshipDefinition, TypeDirection } from '../schema/relationship-definition.schema';

// ============================================================================
// Severity Enum
// ============================================================================

export type Severity = 'error' | 'warning' | 'info';

// ============================================================================
// Parsed Entity Types
// ============================================================================

export interface ParsedField {
	name: string;
	type: string;
	required: boolean;
	nullable: boolean;
	unique: boolean;
	index: boolean;
	foreignKey?: { table: string; column: string };
	choices?: string[];
	/**
	 * `choices_from:` — the path of the YAML file an enum loads its values from.
	 * Carried (not resolved) so consumers that only need to know the domain is
	 * DECLARED — the semantic emitter's `hasDeclaredDomain` — can see it.
	 */
	choicesFrom?: string;
	constraints: {
		minLength?: number;
		maxLength?: number;
		min?: number;
		max?: number;
	};
	ui: {
		label?: string;
		type?: string;
		importance?: string;
		group?: string;
		sortable?: boolean;
		filterable?: boolean;
		visible?: boolean;
		placeholder?: string;
		help?: string;
		format?: Record<string, unknown>;
		/** Curated/displayed field (qField `isKeyField` parity, ADR-040). */
		keyField?: boolean;
		/** Sort position within the key-field set (qField `keyFieldOrder`). */
		keyFieldOrder?: number;
	};
	/** Semantic-layer field tags (SEM-1, ADR-045). */
	analytics: ParsedFieldAnalytics;
}

/**
 * Field-level analytics tags as parsed from the YAML (SEM-1).
 *
 * The object is always present (mirroring `ParsedField.ui`) so downstream
 * emitters read one shape; an untagged field has every key undefined.
 * `type` / `column` / `hasDeclaredDomain` are NOT here — they are derived at
 * emit time from the field's `type:`, the naming config and `choices`.
 */
export interface ParsedFieldAnalytics {
	role?: 'measure' | 'dimension';
	agg?: Agg;
	aggs?: Agg[];
	additivity?: Additivity;
	time?: boolean;
}

export interface ParsedRelationship {
	name: string;
	type: 'belongs_to' | 'has_many' | 'has_one';
	target: string;
	foreignKey: string;
	inverse?: string;
	through?: string; // For transitive relationships: "owned_opportunities.updates"
	resolved: boolean;
	/**
	 * CAP-2: set when this relationship was DERIVED from a `roles:` entry of
	 * that name. Consumers that care about the edge treat it like any other
	 * `belongs_to`; consumers that care about *why* it exists (the semantic
	 * model's dimension label, CAP-3's role vocabulary) read this.
	 */
	role?: string;
}

interface ParsedRoleBase {
	name: string;
	/** Actor entity the role points at. */
	target: string;
}

/** A `cardinality: one` role — derives a `belongs_to` on this entity. */
export interface ParsedOneRole extends ParsedRoleBase {
	cardinality: 'one';
	/** Explicit FK column, when the author overrode `<role>_<target>_id`. */
	column?: string;
	nullable?: boolean;
	onDelete?: 'restrict' | 'cascade' | 'set_null' | 'no_action';
	/** The FK column the role derives (`column` or `<role>_<target>_id`). */
	foreignKey: string;
}

/** A `cardinality: many` role — names the junction that owns the edge. */
export interface ParsedManyRole extends ParsedRoleBase {
	cardinality: 'many';
	/** The junction between this entity and `target`. */
	via: string;
}

/**
 * One `roles:` entry as authored (CAP-2, ADR-041) — a named, typed edge to an
 * actor entity.
 *
 * A `cardinality: one` role ALSO appears in `ParsedEntity.relationships` as a
 * derived `belongs_to` keyed by the role name, so graph building, reference
 * resolution and the relations manifest see it as the edge it is. This record
 * keeps the *declaration*, which is what CAP-3's `Communication` mixin and the
 * semantic model read (the role name is the dimension label; the derived
 * relationship only knows its FK).
 *
 * Discriminated on `cardinality`: a one-role always has `foreignKey`, a
 * many-role always has `via`.
 */
export type ParsedRole = ParsedOneRole | ParsedManyRole;

export interface ParsedQuery {
	by: string[];
	unique?: boolean;
	select?: string[];
	order?: string;
	limit?: boolean;
	via?: string;
}

export interface ParsedProviderIntegration {
	remoteEntity: string;
	direction: 'inbound' | 'outbound' | 'bidirectional';
	cdc: boolean;
	fieldMapping?: Record<string, string>;
	readOnlyFields?: string[];
}

export interface ParsedIntegration {
	electric: boolean;
	providers?: Record<string, ParsedProviderIntegration>;
}

export interface ParsedEvent {
	name: string;
	queue: string;
	body: Record<string, string>;
	generateHandler: boolean;
}

export interface ParsedEntity {
	name: string;
	plural: string;
	table: string;
	/**
	 * Single pattern name (ADR-031). Mutually exclusive with `patterns`.
	 * Resolves against the pattern registry (`src/patterns/registry.ts`)
	 * at codegen time.
	 */
	pattern?: string;
	/** Multi-pattern composition. Mutually exclusive with `pattern`. */
	patterns?: string[];
	/**
	 * Per-pattern config map — key is pattern name, value is the raw YAML
	 * block. Composition validation (PATTERN-4) parses each value against
	 * the pattern's `configSchema` before codegen emits it as the
	 * generated class's `patternConfig` property.
	 */
	patternConfig?: Record<string, unknown>;
	/** Whether this entity is a valid scope target for job scoping (JOB-7). */
	scopeable?: boolean;
	/**
	 * Which layers to generate (entity `expose:`, default
	 * `['repository', 'rest', 'trpc']`). The frontend field-metadata emitter
	 * (FE-3) derives write `capabilities` from whether `repository` or `trpc`
	 * is exposed.
	 */
	expose: ('repository' | 'rest' | 'trpc' | 'electric')[];
	folderStructure: 'nested' | 'flat';
	fields: Map<string, ParsedField>;
	relationships: Map<string, ParsedRelationship>;
	/**
	 * CAP-2 `roles:` — named edges to actor entities, keyed by role name.
	 * `cardinality: one` roles are ALSO present in `relationships` as derived
	 * `belongs_to` entries under the same key.
	 */
	roles?: Map<string, ParsedRole>;
	behaviors: string[];
	queries?: ParsedQuery[];
	integration?: ParsedIntegration;
	events?: ParsedEvent[];
	/**
	 * EVT-7: Opt-in list of event types this entity emits from its generated
	 * use-cases via `TypedEventBus.publish(...)`. `undefined` ⇒ no `emits:`
	 * block declared (fallback to untyped lifecycle events + warning);
	 * `[]` ⇒ explicit opt-out (no warning, no typed emission).
	 */
	emits?: string[];
	/**
	 * Entity-level `analytics:` block (SEM-1) — the composite metric catalog.
	 * An authoring home, not a scope: the emitted catalog is one flat
	 * namespace, so a metric here may name legs on another entity.
	 */
	analytics?: ParsedEntityAnalytics;
	sourcePath: string;
}

/** Entity-level analytics block as parsed from the YAML (SEM-1). */
export interface ParsedEntityAnalytics {
	metrics?: Record<string, MetricDefinition>;
}

// ============================================================================
// Parsed Relationship Definition Types (first-class junction entities)
// ============================================================================

/**
 * Direction metadata for a single relationship type.
 * Resolved from the YAML types: block (simple list or object map).
 */
export interface ParsedTypeDirection {
	name: string;
	inverse?: string;
	bidirectional: boolean;
	directed: boolean;
}

/**
 * A parsed relationship definition — a first-class junction entity
 * between two core entities. Loaded from relationship YAML files.
 *
 * This is NOT the same as ParsedRelationship (which is an inline
 * belongs_to/has_many/has_one on an entity). This represents a full
 * junction table with its own fields, types, temporal/sourced flags.
 */
export interface ParsedRelationshipDefinition {
	name: string;
	table: string;
	from: string;
	to: string;
	selfReferential: boolean;

	// FK column names (derived from from/to)
	fromColumn: string;
	toColumn: string;

	// Type taxonomy
	types: ParsedTypeDirection[];
	hasTypes: boolean;

	// Behavioral flags
	temporal: boolean;
	sourced: boolean;

	// On-delete semantics (ADR-021)
	onDeleteFrom: 'restrict' | 'cascade' | 'set_null' | 'no_action';
	onDeleteTo: 'restrict' | 'cascade' | 'set_null' | 'no_action';

	// Unique constraint columns
	uniqueOn: string[];

	// Custom fields (beyond auto-generated)
	fields: Map<string, ParsedField>;

	// Declarative queries
	queries?: ParsedQuery[];

	// Source file path
	sourcePath: string;
}

// ============================================================================
// Graph Types
// ============================================================================

export interface EntityNode {
	id: string;
	name: string;
	entity: ParsedEntity;
}

export interface RelationshipEdge {
	from: string;
	to: string;
	relationship: ParsedRelationship;
	cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
	bidirectional: boolean;
}

export interface DomainGraph {
	entities: Map<string, ParsedEntity>;
	relationshipDefinitions: Map<string, ParsedRelationshipDefinition>;
	edges: RelationshipEdge[];
}

// ============================================================================
// Analysis Types
// ============================================================================

export interface AnalysisIssue {
	severity: Severity;
	type: string;
	entity?: string;
	field?: string;
	message: string;
	path?: string;
	suggestion?: string;
}

export interface DomainStatistics {
	totalEntities: number;
	totalFields: number;
	totalRelationships: number;
	fieldsByType: Record<string, number>;
	relationshipsByType: Record<string, number>;
	entitiesWithBehaviors: number;
	averageFieldsPerEntity: number;
}

export interface AnalysisResult {
	isValid: boolean;
	entities: ParsedEntity[];
	relationshipDefinitions: ParsedRelationshipDefinition[];
	graph: DomainGraph;
	issues: AnalysisIssue[];
	statistics: DomainStatistics;
}

// ============================================================================
// Output Format Types
// ============================================================================

export type OutputFormat = 'console' | 'json' | 'markdown';

// ============================================================================
// Transitive Relationship Types
// ============================================================================

export interface PathHop {
	via: string; // Intermediate entity name
	relationship: string; // Relationship name used at this hop
	foreignKey: string; // FK field for this hop
}

export interface TransitivePath {
	source: string; // Starting entity (e.g., "user")
	target: string; // Final entity (e.g., "action_item")
	hops: PathHop[]; // Path through the graph
	suggestedName: string; // Generated name (e.g., "owned_action_items")
	throughPath: string; // Dot-separated path (e.g., "meetings.action_items")
	yamlSnippet: string; // Ready-to-paste YAML
}

export interface TransitiveSuggestion extends Omit<AnalysisIssue, 'path'> {
	type: 'transitive_suggestion';
	path: TransitivePath;
}

// ============================================================================
// Manifest Types
// ============================================================================

export interface ManifestField {
	name: string;
	type: string;
	required: boolean;
	nullable: boolean;
	unique: boolean;
	index: boolean;
	foreignKey?: { table: string; column: string };
	choices?: string[];
}

export interface ManifestRelationship {
	type: 'belongs_to' | 'has_many' | 'has_one';
	target: string;
	foreignKey: string;
	through?: string;
	inverse?: string;
}

export interface ManifestEntity {
	sourcePath: string;
	table: string;
	plural: string;
	fields: Record<string, ManifestField>;
	relationships: Record<string, ManifestRelationship>;
	behaviors: string[];
}

export interface ManifestSuggestion {
	id: string; // Stable ID: "source->target"
	source: string;
	target: string;
	throughPath: string;
	suggestedName: string;
	yamlSnippet: string;
	status: 'pending' | 'accepted' | 'skipped';
	detectedAt: string; // ISO timestamp
	resolvedAt?: string; // When accepted/skipped
}

export interface CodegenManifest {
	version: 1;
	generatedAt: string;
	entityFilesHash: string; // For staleness detection

	entities: Record<string, ManifestEntity>;

	graph: {
		edges: Array<{
			from: string;
			to: string;
			relationship: string;
			cardinality: '1:1' | '1:N' | 'N:1';
			bidirectional: boolean;
		}>;
		orphans: string[];
		cycles: string[][];
	};

	suggestions: {
		transitive: ManifestSuggestion[];
	};

	statistics: {
		totalEntities: number;
		totalFields: number;
		totalRelationships: number;
		transitivePathsDetected: number;
	};
}
