/**
 * The inputs `deriveEntityApiSurface` takes, built for a closed set of entity + junction definitions exactly as
 * `buildBackendLocals` holds them: the pattern composition from `entity-locals.js`'s own
 * `resolvePatternComposition` (passed in, never re-resolved), the cross-entity lookup from the set's own
 * `entity:` blocks, and every entity of the set wired — the answer is "what `entity new --all` emits".
 *
 * Shared by the parity, golden and raw ≡ parsed tests, so all three derive the same thing.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'yaml';

import { resolvePatternComposition } from '../../../templates/entity/new/backend/entity-locals.js';
import { entityLookupFrom } from '../../../templates/_shared/entity-naming.mjs';
import { loadCodegenConfig } from '../../config/project-config';
import {
	deriveEntityApiSurface,
	type EntityBlockInput,
	type EntityDefinitionInput,
	type JunctionInput,
} from '../../derived/api/entity';
import type { EntityApiSurface } from '../../derived/api/types';
import { validateEntityDefinition } from '../../schema/entity-definition.schema';
import { validateJunctionDefinition } from '../../schema/junction-definition.schema';

export const REPO_ROOT = resolve(import.meta.dir, '../../..');

/** A closed set: every entity a definition references is in `entities`. */
export interface DefinitionSet {
	entities: EntityDefinitionInput[];
	junctions: JunctionInput[];
}

/** Derive every entity of a set. `wiredTargets` defaults to the whole set. */
export function deriveSet(set: DefinitionSet, wiredTargets?: Iterable<string>): Map<string, EntityApiSurface> {
	const blocks: EntityBlockInput[] = set.entities.map((d) => d.entity);
	const entityLookup = entityLookupFrom(blocks) as (name: string) => EntityBlockInput | null;
	const wired = [...(wiredTargets ?? set.entities.map((d) => d.entity.name))];
	const out = new Map<string, EntityApiSurface>();
	for (const definition of set.entities) {
		out.set(
			definition.entity.name,
			deriveEntityApiSurface({
				definition,
				junctions: set.junctions,
				composition: resolvePatternComposition(definition.entity),
				wiredTargets: wired,
				entityLookup,
			}),
		);
	}
	return out;
}

/** The same set run through the schema — what the CLI hands the derivation. */
export function parsedSet(set: DefinitionSet): DefinitionSet {
	return {
		entities: set.entities.map((d) => validateEntityDefinition(structuredClone(d)) as EntityDefinitionInput),
		junctions: set.junctions.map((j) => validateJunctionDefinition(structuredClone(j)) as JunctionInput),
	};
}

// ---------------------------------------------------------------------------
// The baseline fixture set (`just test-baseline`)
// ---------------------------------------------------------------------------

export const BASELINE_CONFIG_FILE = join(REPO_ROOT, 'test/fixtures/codegen.config.yaml');
export const BASELINE_ENTITIES_DIR = join(REPO_ROOT, 'test/fixtures/entities');
/** Where the baseline's generated tree is checked in, relative to the repo root. */
export const BASELINE_ROOT = 'test/baseline';

/** The baseline config's module tree root (`paths.modules_dir`), relative to the generated project. */
export function baselineModulesDir(): string {
	return loadCodegenConfig(BASELINE_CONFIG_FILE).paths.modules_dir;
}

/**
 * The baseline's entity set, raw YAML, as hygen reads it. No junction: the baseline project declares none (its
 * config names no junctions directory, and nothing under `test/baseline` carries a fan-out).
 */
export function baselineSet(): DefinitionSet {
	const files = readdirSync(BASELINE_ENTITIES_DIR)
		.filter((f) => f.endsWith('.yaml'))
		.sort();
	return {
		entities: files.map((f) => yaml.parse(readFileSync(join(BASELINE_ENTITIES_DIR, f), 'utf-8')) as EntityDefinitionInput),
		junctions: [],
	};
}
