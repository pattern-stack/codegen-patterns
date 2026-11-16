/**
 * Test helper — the RFC-0006 §13.1 fixture family, loaded the way production
 * loads it, with an optional per-entity mutation applied to the raw YAML first
 * so a negative case is "the family, with one line changed".
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { ParsedEntity } from '../../analyzer/types';
import { loadEntities, transformToEntity } from '../../parser/load-entities';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';
import { findYamlFiles } from '../../utils/find-yaml-files';

export const FAMILY_DIR = join(import.meta.dir, '../../../test/fixtures/inheritance/entities');
/** The integrated family (S7, #917): a base, two Integrated children and a base-only kind. Validation tests only; no emitting set holds it. */
export const INTEGRATED_FAMILY_DIR = join(import.meta.dir, '../../../test/fixtures/integrated-child/entities');

// biome-ignore lint/suspicious/noExplicitAny: raw YAML in a test mutator
export type RawYaml = Record<string, any>;
export type Mutations = Record<string, (raw: RawYaml) => void>;

/** The family through the real loader — no mutation. */
export function loadFamily(dir = FAMILY_DIR): ParsedEntity[] {
	const { entities, issues } = loadEntities(dir, { tablePrefix: '', nonEntityDirs: [] });
	const errors = issues.filter((i) => i.severity === 'error');
	if (errors.length > 0) {
		throw new Error(`fixture family failed to load:\n${errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`);
	}
	return entities;
}

/** Raw YAML through the real schema and the real parse step. Throws if it no longer passes the schema. */
export function parseRaw(raw: RawYaml, filePath = 'test.yaml'): ParsedEntity {
	return transformToEntity({ success: true, definition: EntityDefinitionSchema.parse(raw), filePath }, '');
}

/**
 * The family with `mutations[entityName](raw)` applied to that entity's raw YAML,
 * then parsed as the loader does. Use `schemaIssues` for single-file cases.
 */
export function familyWith(mutations: Mutations, dir = FAMILY_DIR): ParsedEntity[] {
	return findYamlFiles(dir).map((file) => {
		const raw = parseYaml(readFileSync(file, 'utf8')) as RawYaml;
		mutations[raw.entity.name]?.(raw);
		return parseRaw(raw, file);
	});
}

/** Raw YAML of one fixture, mutated, for schema-only (single-file) cases. */
export function rawFixture(name: string, mutate?: (raw: RawYaml) => void, dir = FAMILY_DIR): RawYaml {
	const raw = parseYaml(readFileSync(join(dir, `${name}.yaml`), 'utf8')) as RawYaml;
	mutate?.(raw);
	return raw;
}

/** Messages from parsing `raw` through the entity schema; empty when it parses. */
export function schemaIssues(raw: unknown): string[] {
	const r = EntityDefinitionSchema.safeParse(raw);
	return r.success ? [] : r.error.issues.map((i) => i.message);
}
