#!/usr/bin/env bun
/**
 * Lint check: Ensures all entity fields have corresponding UI metadata.
 *
 * Usage: bun tools/codegen/scripts/lint-metadata.ts
 *
 * This script validates:
 * - Each entity YAML file has a corresponding metadata file generated
 * - Warns (but does not error) on missing explicit UI metadata properties
 *
 * Exit codes:
 * - 0: All checks passed (warnings are OK)
 * - 1: Errors found (missing metadata files)
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import yaml from 'yaml';

const ENTITIES_DIR = 'entities';
const METADATA_DIR = 'apps/frontend/src/generated/entity-metadata';

interface LintError {
	entity: string;
	field: string;
	message: string;
}

interface LintWarning {
	entity: string;
	field: string;
	property: string;
}

async function lintMetadata(): Promise<{
	errors: LintError[];
	warnings: LintWarning[];
}> {
	const errors: LintError[] = [];
	const warnings: LintWarning[] = [];

	// Check if entities directory exists
	if (!existsSync(ENTITIES_DIR)) {
		console.log('No entities directory found - skipping metadata lint');
		return { errors, warnings };
	}

	// Find all entity YAML files
	const yamlFiles = readdirSync(ENTITIES_DIR).filter(
		(f) => f.endsWith('.yaml') || f.endsWith('.yml'),
	);

	if (yamlFiles.length === 0) {
		console.log('No entity YAML files found - skipping metadata lint');
		return { errors, warnings };
	}

	for (const yamlFile of yamlFiles) {
		const yamlPath = resolve(ENTITIES_DIR, yamlFile);

		let data: Record<string, unknown>;
		try {
			const content = readFileSync(yamlPath, 'utf-8');
			data = yaml.parse(content) as Record<string, unknown>;
		} catch (e) {
			console.warn(`[WARN] Could not parse ${yamlFile}: ${e}`);
			continue;
		}

		const entityConfig = data.entity as { name?: string } | undefined;
		const entityName = entityConfig?.name;

		if (!entityName) {
			console.warn(`[WARN] ${yamlFile}: Missing entity.name`);
			continue;
		}

		// Check if metadata file exists
		const metadataFile = resolve(METADATA_DIR, `${entityName}.ts`);
		if (!existsSync(metadataFile)) {
			errors.push({
				entity: entityName,
				field: '*',
				message: `Metadata file missing: ${metadataFile}`,
			});
			continue;
		}

		// Check each field for recommended UI properties (warnings only)
		const fields = (data.fields || {}) as Record<string, Record<string, unknown>>;

		for (const [fieldName, fieldDef] of Object.entries(fields)) {
			// Check for recommended UI properties
			const recommendedProps = [
				'ui_label',
				'ui_type',
				'ui_importance',
				'ui_group',
			];

			for (const prop of recommendedProps) {
				if (fieldDef[prop] === undefined) {
					warnings.push({
						entity: entityName,
						field: fieldName,
						property: prop,
					});
				}
			}
		}
	}

	return { errors, warnings };
}

// Run lint
lintMetadata()
	.then(({ errors, warnings }) => {
		// Print warnings grouped by entity
		if (warnings.length > 0) {
			console.log('\nUI Metadata Warnings (values will be auto-inferred):');

			// Group warnings by entity
			const byEntity = new Map<string, LintWarning[]>();
			for (const w of warnings) {
				const existing = byEntity.get(w.entity) || [];
				existing.push(w);
				byEntity.set(w.entity, existing);
			}

			for (const [entity, entityWarnings] of byEntity) {
				// Group by field
				const byField = new Map<string, string[]>();
				for (const w of entityWarnings) {
					const existing = byField.get(w.field) || [];
					existing.push(w.property);
					byField.set(w.field, existing);
				}

				console.log(`  ${entity}:`);
				for (const [field, props] of byField) {
					console.log(`    ${field}: missing ${props.join(', ')}`);
				}
			}
		}

		// Print errors
		if (errors.length > 0) {
			console.error('\nMetadata Lint Errors:');
			for (const e of errors) {
				console.error(`  ${e.entity}.${e.field}: ${e.message}`);
			}
			console.error(`\n${errors.length} error(s) found`);
			process.exit(1);
		}

		// Success
		if (warnings.length > 0) {
			console.log(
				`\nMetadata lint passed with ${warnings.length} warning(s)`,
			);
		} else {
			console.log('Metadata lint passed');
		}
		process.exit(0);
	})
	.catch((e) => {
		console.error('Lint failed with error:', e);
		process.exit(1);
	});
