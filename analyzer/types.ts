/**
 * Domain Analyzer Types
 *
 * Core type definitions for the domain analysis tool.
 */

import type { EntityDefinition } from '../schema/entity-definition.schema';

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
	};
}

export interface ParsedRelationship {
	name: string;
	type: 'belongs_to' | 'has_many' | 'has_one';
	target: string;
	foreignKey: string;
	inverse?: string;
	through?: string; // For transitive relationships: "owned_opportunities.updates"
	resolved: boolean;
}

export type EntityFamily = 'crm-synced' | 'activity' | 'knowledge' | 'metadata';

export interface ParsedQuery {
	by: string[];
	unique?: boolean;
	select?: string[];
	order?: string;
	limit?: boolean;
	via?: string;
}

export interface ParsedProviderSync {
	remoteEntity: string;
	direction: 'inbound' | 'outbound' | 'bidirectional';
	cdc: boolean;
	fieldMapping?: Record<string, string>;
	readOnlyFields?: string[];
}

export interface ParsedSync {
	electric: boolean;
	providers?: Record<string, ParsedProviderSync>;
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
	family?: EntityFamily;
	folderStructure: 'nested' | 'flat';
	fields: Map<string, ParsedField>;
	relationships: Map<string, ParsedRelationship>;
	behaviors: string[];
	queries?: ParsedQuery[];
	sync?: ParsedSync;
	events?: ParsedEvent[];
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

export interface TransitiveSuggestion extends AnalysisIssue {
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
