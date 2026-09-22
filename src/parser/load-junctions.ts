/**
 * Junction discovery for the analyzer (CAP-2).
 *
 * Junction YAMLs live in their own `junctions/` directory (`codegen junction
 * new` reads it; there is no config key). The analyzer never needed them until
 * a `cardinality: many` role began naming one with `via:` — this is the minimum
 * the roles validator needs to check that the named junction exists and joins
 * the right two entities.
 */

import fs from 'node:fs';
import path from 'node:path';
import { deriveJunctionName } from '../schema/junction-definition.schema';
import type { JunctionSummary } from '../roles/validate-roles';
import { findYamlFiles } from '../utils/find-yaml-files';
import { loadJunctionFromYaml } from '../utils/yaml-loader';

/** The junctions directory for a project — the convention `junction new` uses. */
export function junctionsDirFor(cwd: string): string {
	return path.resolve(cwd, 'junctions');
}

/**
 * Every junction YAML under `dir`, reduced to its name and pairing. A missing
 * directory is an empty list, not an error: most projects have no junctions.
 * Files that are not junctions (or fail the junction schema) are skipped — the
 * junction command is the authoritative reporter of junction-schema errors.
 */
export function loadJunctionSummaries(dir: string): JunctionSummary[] {
	if (!fs.existsSync(dir)) return [];
	const summaries: JunctionSummary[] = [];
	for (const file of findYamlFiles(dir)) {
		const result = loadJunctionFromYaml(file);
		if (!result.success) continue;
		summaries.push({
			name: deriveJunctionName(result.definition),
			between: result.definition.between,
		});
	}
	return summaries.sort((a, b) => a.name.localeCompare(b.name));
}
