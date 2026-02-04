/**
 * Manifest Persistence
 *
 * Handles reading, writing, and staleness detection for the codegen manifest.
 * Uses SHA-256 hash of entity files for deterministic staleness checking.
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type {
	CodegenManifest,
	AnalysisResult,
	TransitiveSuggestion,
	ManifestEntity,
	ManifestField,
	ManifestRelationship,
	ManifestSuggestion,
	ParsedEntity,
} from './types';
import { findOrphanEntities, findCircularDependencies } from './graph-builder';

// ============================================================================
// Constants
// ============================================================================

export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_VERSION = 1;

/**
 * Get the manifest directory name (configurable via env var)
 */
export function getManifestDir(): string {
	return process.env.CODEGEN_MANIFEST_DIR || '.codegen';
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Get manifest directory and file paths
 */
export function getManifestPaths(projectRoot: string): { dir: string; file: string } {
	const dir = join(projectRoot, getManifestDir());
	const file = join(dir, MANIFEST_FILE);
	return { dir, file };
}

// ============================================================================
// Hash Computation
// ============================================================================

/**
 * Compute SHA-256 hash of all YAML files in the entities directory.
 * Results are deterministic (sorted file order).
 */
export async function computeEntityFilesHash(entitiesDir: string): Promise<string> {
	if (!existsSync(entitiesDir)) {
		return createHash('sha256').update('').digest('hex');
	}

	// Recursively gather all YAML files
	const yamlFiles: string[] = [];

	function walkDir(dir: string): void {
		const entries = readdirSync(dir);
		for (const entry of entries) {
			const fullPath = join(dir, entry);
			const stat = statSync(fullPath);
			if (stat.isDirectory()) {
				walkDir(fullPath);
			} else if (stat.isFile() && (entry.endsWith('.yaml') || entry.endsWith('.yml'))) {
				yamlFiles.push(fullPath);
			}
		}
	}

	walkDir(entitiesDir);

	// Sort for deterministic hashing
	yamlFiles.sort();

	// Compute combined hash
	const hash = createHash('sha256');
	for (const file of yamlFiles) {
		const content = readFileSync(file, 'utf-8');
		hash.update(file); // Include file path for uniqueness
		hash.update(content);
	}

	return hash.digest('hex');
}

// ============================================================================
// Manifest I/O
// ============================================================================

/**
 * Read manifest from disk.
 * Returns null if not found or version mismatch.
 */
export function readManifest(projectRoot: string): CodegenManifest | null {
	const { file } = getManifestPaths(projectRoot);

	if (!existsSync(file)) {
		return null;
	}

	try {
		const content = readFileSync(file, 'utf-8');
		const manifest = JSON.parse(content) as CodegenManifest;

		// Version check
		if (manifest.version !== MANIFEST_VERSION) {
			return null;
		}

		return manifest;
	} catch (error) {
		// Invalid JSON or read error
		return null;
	}
}

/**
 * Write manifest to disk.
 * Creates .codegen directory if needed.
 */
export function writeManifest(projectRoot: string, manifest: CodegenManifest): void {
	const { dir, file } = getManifestPaths(projectRoot);

	// Ensure directory exists
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	// Write manifest with pretty formatting
	const content = JSON.stringify(manifest, null, 2);
	writeFileSync(file, content, 'utf-8');
}

// ============================================================================
// Staleness Detection
// ============================================================================

/**
 * Check if manifest is stale (entity files have changed).
 */
export async function isManifestStale(
	projectRoot: string,
	entitiesDir: string
): Promise<boolean> {
	const manifest = readManifest(projectRoot);

	if (!manifest) {
		return true; // No manifest = stale
	}

	const currentHash = await computeEntityFilesHash(entitiesDir);
	return manifest.entityFilesHash !== currentHash;
}

// ============================================================================
// Manifest Building
// ============================================================================

/**
 * Convert ParsedEntity to ManifestEntity
 */
function toManifestEntity(entity: ParsedEntity): ManifestEntity {
	const fields: Record<string, ManifestField> = {};
	for (const [name, field] of entity.fields) {
		fields[name] = {
			name: field.name,
			type: field.type,
			required: field.required,
			nullable: field.nullable,
			unique: field.unique,
			index: field.index,
			foreignKey: field.foreignKey,
			choices: field.choices,
		};
	}

	const relationships: Record<string, ManifestRelationship> = {};
	for (const [name, rel] of entity.relationships) {
		relationships[name] = {
			type: rel.type,
			target: rel.target,
			foreignKey: rel.foreignKey,
			through: rel.through,
			inverse: rel.inverse,
		};
	}

	return {
		sourcePath: entity.sourcePath,
		table: entity.table,
		plural: entity.plural,
		fields,
		relationships,
		behaviors: entity.behaviors,
	};
}

/**
 * Merge transitive suggestions with existing manifest suggestions.
 * Preserves status (pending/accepted/skipped) from existing manifest.
 */
function mergeSuggestions(
	newSuggestions: TransitiveSuggestion[],
	existingManifest?: CodegenManifest | null
): ManifestSuggestion[] {
	const now = new Date().toISOString();
	const existingSuggestions = existingManifest?.suggestions.transitive || [];
	const existingMap = new Map<string, ManifestSuggestion>();

	// Build map of existing suggestions by ID
	for (const existing of existingSuggestions) {
		existingMap.set(existing.id, existing);
	}

	// Merge new suggestions
	const merged: ManifestSuggestion[] = [];

	for (const suggestion of newSuggestions) {
		const id = `${suggestion.path.source}->${suggestion.path.target}`;
		const existing = existingMap.get(id);

		if (existing) {
			// Preserve existing suggestion with updated content
			merged.push({
				id,
				source: suggestion.path.source,
				target: suggestion.path.target,
				throughPath: suggestion.path.throughPath,
				suggestedName: suggestion.path.suggestedName,
				yamlSnippet: suggestion.path.yamlSnippet,
				status: existing.status, // Preserve status
				detectedAt: existing.detectedAt, // Preserve original detection time
				resolvedAt: existing.resolvedAt,
			});
			existingMap.delete(id); // Mark as processed
		} else {
			// New suggestion
			merged.push({
				id,
				source: suggestion.path.source,
				target: suggestion.path.target,
				throughPath: suggestion.path.throughPath,
				suggestedName: suggestion.path.suggestedName,
				yamlSnippet: suggestion.path.yamlSnippet,
				status: 'pending',
				detectedAt: now,
			});
		}
	}

	// Keep resolved suggestions from existing manifest (accepted/skipped)
	for (const [id, existing] of existingMap) {
		if (existing.status !== 'pending') {
			merged.push(existing);
		}
		// Pending suggestions that are no longer detected are dropped
	}

	return merged;
}

/**
 * Build manifest from analysis result
 */
export async function buildManifest(
	analysis: AnalysisResult,
	transitiveSuggestions: TransitiveSuggestion[],
	entitiesDir: string,
	existingManifest?: CodegenManifest | null
): Promise<CodegenManifest> {
	const entities: Record<string, ManifestEntity> = {};

	// Convert entities
	for (const entity of analysis.entities) {
		entities[entity.name] = toManifestEntity(entity);
	}

	// Build graph metadata
	const orphans = findOrphanEntities(analysis.graph);
	const cycles = findCircularDependencies(analysis.graph);

	// Merge suggestions (preserving existing status)
	const mergedSuggestions = mergeSuggestions(transitiveSuggestions, existingManifest);

	// Compute entity files hash
	const entityFilesHash = await computeEntityFilesHash(entitiesDir);

	const manifest: CodegenManifest = {
		version: MANIFEST_VERSION,
		generatedAt: new Date().toISOString(),
		entityFilesHash,
		entities,
		graph: {
			edges: analysis.graph.edges.map((edge) => ({
				from: edge.from,
				to: edge.to,
				relationship: edge.relationship.name,
				cardinality: edge.cardinality === 'N:M' ? '1:N' : edge.cardinality,
				bidirectional: edge.bidirectional,
			})),
			orphans,
			cycles,
		},
		suggestions: {
			transitive: mergedSuggestions,
		},
		statistics: {
			totalEntities: analysis.statistics.totalEntities,
			totalFields: analysis.statistics.totalFields,
			totalRelationships: analysis.statistics.totalRelationships,
			transitivePathsDetected: transitiveSuggestions.length,
		},
	};

	return manifest;
}

// ============================================================================
// Suggestion Management
// ============================================================================

/**
 * Update status of a specific suggestion.
 * Returns true if updated, false if suggestion not found.
 */
export function updateSuggestionStatus(
	projectRoot: string,
	suggestionId: string,
	status: 'accepted' | 'skipped'
): boolean {
	const manifest = readManifest(projectRoot);
	if (!manifest) {
		return false;
	}

	const suggestion = manifest.suggestions.transitive.find((s) => s.id === suggestionId);
	if (!suggestion) {
		return false;
	}

	suggestion.status = status;
	suggestion.resolvedAt = new Date().toISOString();

	writeManifest(projectRoot, manifest);
	return true;
}

/**
 * Update status of all pending suggestions.
 * Returns count of updated suggestions.
 */
export function updateAllSuggestionStatus(
	projectRoot: string,
	status: 'accepted' | 'skipped'
): number {
	const manifest = readManifest(projectRoot);
	if (!manifest) {
		return 0;
	}

	let count = 0;
	const now = new Date().toISOString();

	for (const suggestion of manifest.suggestions.transitive) {
		if (suggestion.status === 'pending') {
			suggestion.status = status;
			suggestion.resolvedAt = now;
			count++;
		}
	}

	if (count > 0) {
		writeManifest(projectRoot, manifest);
	}

	return count;
}

/**
 * Get all pending suggestions from manifest.
 */
export function getPendingSuggestions(projectRoot: string): ManifestSuggestion[] {
	const manifest = readManifest(projectRoot);
	if (!manifest) {
		return [];
	}

	return manifest.suggestions.transitive.filter((s) => s.status === 'pending');
}
