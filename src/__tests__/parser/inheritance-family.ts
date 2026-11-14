/**
 * Test helper — the RFC-0006 §13.1 fixture family, loaded the way production
 * loads it, with an optional per-entity mutation applied to the raw YAML first
 * so a negative case is "the family, with one line changed".
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { InheritanceEntity } from '../../parser/validate-inheritance';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';
import { findYamlFiles } from '../../utils/find-yaml-files';
import { loadEntitiesFromYaml } from '../../utils/yaml-loader';

export const FAMILY_DIR = join(import.meta.dir, '../../../test/fixtures/inheritance/entities');

// biome-ignore lint/suspicious/noExplicitAny: raw YAML in a test mutator
export type RawYaml = Record<string, any>;
export type Mutations = Record<string, (raw: RawYaml) => void>;

/** The family through the real loader — no mutation. */
export function loadFamily(): InheritanceEntity[] {
	const { successes, failures } = loadEntitiesFromYaml(findYamlFiles(FAMILY_DIR));
	if (failures.length > 0) {
		throw new Error(`fixture family failed to load:\n${failures.map((f) => `${f.filePath}: ${f.error} ${(f.details ?? []).join('; ')}`).join('\n')}`);
	}
	return successes.map((s) => ({ definition: s.definition, filePath: s.filePath }));
}

/**
 * The family with `mutations[entityName](raw)` applied to that entity's raw YAML,
 * then parsed through the real schema. Throws if a mutated entity no longer
 * passes the schema (use `schemaIssues` for single-file cases).
 */
export function familyWith(mutations: Mutations): InheritanceEntity[] {
	const out: InheritanceEntity[] = [];
	for (const file of findYamlFiles(FAMILY_DIR)) {
		const raw = parseYaml(readFileSync(file, 'utf8')) as RawYaml;
		mutations[raw.entity.name]?.(raw);
		out.push({ definition: EntityDefinitionSchema.parse(raw), filePath: file });
	}
	return out;
}

/** Raw YAML of one fixture, mutated, for schema-only (single-file) cases. */
export function rawFixture(name: string, mutate?: (raw: RawYaml) => void): RawYaml {
	const raw = parseYaml(readFileSync(join(FAMILY_DIR, `${name}.yaml`), 'utf8')) as RawYaml;
	mutate?.(raw);
	return raw;
}

/** Messages from parsing `raw` through the entity schema; empty when it parses. */
export function schemaIssues(raw: unknown): string[] {
	const r = EntityDefinitionSchema.safeParse(raw);
	return r.success ? [] : r.error.issues.map((i) => i.message);
}
