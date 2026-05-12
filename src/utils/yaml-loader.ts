import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import {
	type EntityDefinition,
	EntityDefinitionSchema,
} from '../schema/entity-definition.schema';
import {
	type EventDefinition,
	EventDefinitionSchema,
} from '../schema/event-definition.schema';
import {
	type RelationshipDefinition,
	RelationshipDefinitionSchema,
} from '../schema/relationship-definition.schema';
import {
	type JunctionDefinition,
	JunctionDefinitionSchema,
} from '../schema/junction-definition.schema';

export interface LoadResult {
	success: true;
	definition: EntityDefinition;
	filePath: string;
}

export interface LoadError {
	success: false;
	error: string;
	details?: string[];
	filePath: string;
}

export type LoadEntityResult = LoadResult | LoadError;

/**
 * Load and validate an entity definition from a YAML file
 */
export function loadEntityFromYaml(filePath: string): LoadEntityResult {
	// Check file exists
	if (!existsSync(filePath)) {
		return {
			success: false,
			error: `File not found: ${filePath}`,
			filePath,
		};
	}

	// Read file
	let content: string;
	try {
		content = readFileSync(filePath, 'utf-8');
	} catch (err) {
		return {
			success: false,
			error: `Failed to read file: ${filePath}`,
			details: [err instanceof Error ? err.message : String(err)],
			filePath,
		};
	}

	// Parse YAML
	let parsed: unknown;
	try {
		parsed = parseYaml(content);
	} catch (err) {
		return {
			success: false,
			error: `Invalid YAML syntax in ${filePath}`,
			details: [err instanceof Error ? err.message : String(err)],
			filePath,
		};
	}

	// Validate against schema
	const result = EntityDefinitionSchema.safeParse(parsed);
	if (!result.success) {
		return {
			success: false,
			error: `Validation failed for ${filePath}`,
			details: formatZodErrors(result.error),
			filePath,
		};
	}

	return {
		success: true,
		definition: result.data,
		filePath,
	};
}

/**
 * Format Zod errors into human-readable messages
 */
function formatZodErrors(error: ZodError): string[] {
	return error.errors.map((err) => {
		const path = err.path.join('.');
		const location = path ? `at '${path}'` : 'at root';
		return `${err.message} ${location}`;
	});
}

/**
 * Pretty-print a load error for CLI output
 */
export function formatLoadError(result: LoadError): string {
	const lines = [`❌ ${result.error}`];
	if (result.details && result.details.length > 0) {
		lines.push('');
		for (const detail of result.details) {
			lines.push(`   • ${detail}`);
		}
	}
	return lines.join('\n');
}

/**
 * Load multiple entity files
 */
export function loadEntitiesFromYaml(filePaths: string[]): {
	successes: LoadResult[];
	failures: LoadError[];
} {
	const successes: LoadResult[] = [];
	const failures: LoadError[] = [];

	for (const filePath of filePaths) {
		const result = loadEntityFromYaml(filePath);
		if (result.success) {
			successes.push(result);
		} else {
			failures.push(result);
		}
	}

	return { successes, failures };
}

// ============================================================================
// Relationship YAML Loading
// ============================================================================

export interface RelationshipLoadResult {
	success: true;
	definition: RelationshipDefinition;
	filePath: string;
}

export interface RelationshipLoadError {
	success: false;
	error: string;
	details?: string[];
	filePath: string;
}

export type LoadRelationshipResult =
	| RelationshipLoadResult
	| RelationshipLoadError;

/**
 * Load and validate a relationship definition from a YAML file
 */
export function loadRelationshipFromYaml(
	filePath: string,
): LoadRelationshipResult {
	if (!existsSync(filePath)) {
		return {
			success: false,
			error: `File not found: ${filePath}`,
			filePath,
		};
	}

	let content: string;
	try {
		content = readFileSync(filePath, 'utf-8');
	} catch (err) {
		return {
			success: false,
			error: `Failed to read file: ${filePath}`,
			details: [err instanceof Error ? err.message : String(err)],
			filePath,
		};
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(content);
	} catch (err) {
		return {
			success: false,
			error: `Invalid YAML syntax in ${filePath}`,
			details: [err instanceof Error ? err.message : String(err)],
			filePath,
		};
	}

	const result = RelationshipDefinitionSchema.safeParse(parsed);
	if (!result.success) {
		return {
			success: false,
			error: `Validation failed for ${filePath}`,
			details: formatZodErrors(result.error),
			filePath,
		};
	}

	return {
		success: true,
		definition: result.data,
		filePath,
	};
}

/**
 * Load multiple relationship files
 */
export function loadRelationshipsFromYaml(filePaths: string[]): {
	successes: RelationshipLoadResult[];
	failures: RelationshipLoadError[];
} {
	const successes: RelationshipLoadResult[] = [];
	const failures: RelationshipLoadError[] = [];

	for (const filePath of filePaths) {
		const result = loadRelationshipFromYaml(filePath);
		if (result.success) {
			successes.push(result);
		} else {
			failures.push(result);
		}
	}

	return { successes, failures };
}

// ============================================================================
// Event YAML Loading
// ============================================================================

export interface EventLoadResult {
	success: true;
	definition: EventDefinition;
	filePath: string;
}

export interface EventLoadError {
	success: false;
	error: string;
	details?: string[];
	filePath: string;
}

export type LoadEventResult = EventLoadResult | EventLoadError;

/**
 * Load and validate a single event definition from a YAML file.
 *
 * Mirrors {@link loadEntityFromYaml}: existence check → readFileSync →
 * parseYaml → `EventDefinitionSchema.safeParse`. Returns a discriminated
 * result; callers are expected to aggregate into `AnalysisIssue`s rather
 * than throw.
 */
export function loadEventFromYaml(filePath: string): LoadEventResult {
	if (!existsSync(filePath)) {
		return {
			success: false,
			error: `File not found: ${filePath}`,
			filePath,
		};
	}

	let content: string;
	try {
		content = readFileSync(filePath, 'utf-8');
	} catch (err) {
		return {
			success: false,
			error: `Failed to read file: ${filePath}`,
			details: [err instanceof Error ? err.message : String(err)],
			filePath,
		};
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(content);
	} catch (err) {
		return {
			success: false,
			error: `Invalid YAML syntax in ${filePath}`,
			details: [err instanceof Error ? err.message : String(err)],
			filePath,
		};
	}

	const result = EventDefinitionSchema.safeParse(parsed);
	if (!result.success) {
		return {
			success: false,
			error: `Validation failed for ${filePath}`,
			details: formatZodErrors(result.error),
			filePath,
		};
	}

	return {
		success: true,
		definition: result.data,
		filePath,
	};
}

// ============================================================================
// Junction YAML Loading
// ============================================================================

export interface JunctionLoadResult {
	success: true;
	definition: JunctionDefinition;
	filePath: string;
}

export interface JunctionLoadError {
	success: false;
	error: string;
	details?: string[];
	filePath: string;
}

export type LoadJunctionResult = JunctionLoadResult | JunctionLoadError;

/**
 * Load and validate a junction definition from a YAML file.
 *
 * Mirrors {@link loadRelationshipFromYaml}: existence check → readFileSync →
 * parseYaml → `JunctionDefinitionSchema.safeParse`. Returns a discriminated
 * result; callers are expected to aggregate into `AnalysisIssue`s rather
 * than throw.
 */
export function loadJunctionFromYaml(filePath: string): LoadJunctionResult {
	if (!existsSync(filePath)) {
		return {
			success: false,
			error: `File not found: ${filePath}`,
			filePath,
		};
	}

	let content: string;
	try {
		content = readFileSync(filePath, 'utf-8');
	} catch (err) {
		return {
			success: false,
			error: `Failed to read file: ${filePath}`,
			details: [err instanceof Error ? err.message : String(err)],
			filePath,
		};
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(content);
	} catch (err) {
		return {
			success: false,
			error: `Invalid YAML syntax in ${filePath}`,
			details: [err instanceof Error ? err.message : String(err)],
			filePath,
		};
	}

	const result = JunctionDefinitionSchema.safeParse(parsed);
	if (!result.success) {
		return {
			success: false,
			error: `Validation failed for ${filePath}`,
			details: formatZodErrors(result.error),
			filePath,
		};
	}

	return {
		success: true,
		definition: result.data,
		filePath,
	};
}

/**
 * Load multiple junction files.
 */
export function loadJunctionsFromYaml(filePaths: string[]): {
	successes: JunctionLoadResult[];
	failures: JunctionLoadError[];
} {
	const successes: JunctionLoadResult[] = [];
	const failures: JunctionLoadError[] = [];

	for (const filePath of filePaths) {
		const result = loadJunctionFromYaml(filePath);
		if (result.success) {
			successes.push(result);
		} else {
			failures.push(result);
		}
	}

	return { successes, failures };
}

/**
 * Detect whether a YAML file is an entity, relationship, or junction definition.
 * Checks for the top-level discriminator key.
 *
 * Junctions are discriminated by `pattern: Junction` (a literal value, not
 * just key presence) so an entity YAML that happens to carry `pattern:
 * Synced` is NOT mistaken for a junction file.
 */
export function detectYamlType(
	filePath: string,
): 'entity' | 'relationship' | 'junction' | 'unknown' {
	if (!existsSync(filePath)) return 'unknown';

	try {
		const content = readFileSync(filePath, 'utf-8');
		const parsed = parseYaml(content) as Record<string, unknown>;
		if (parsed && typeof parsed === 'object') {
			// Junction discriminator is value-sensitive (must be exactly the
			// literal 'Junction'). Check BEFORE 'entity' so we don't mistake
			// a top-level junction file for an entity simply because both
			// schemas could in principle nest a `pattern:` key.
			if (parsed.pattern === 'Junction') return 'junction';
			if ('entity' in parsed) return 'entity';
			if ('relationship' in parsed) return 'relationship';
		}
	} catch {
		// Fall through
	}
	return 'unknown';
}
