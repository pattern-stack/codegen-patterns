import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import {
	type EntityDefinition,
	EntityDefinitionSchema,
} from '../schema/entity-definition.schema';

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
