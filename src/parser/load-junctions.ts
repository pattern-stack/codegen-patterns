/**
 * Junction discovery for the CLI and the analyzer.
 *
 * Junction YAMLs live in their own directory (`src/config/junctions-dir.ts` —
 * no config key). Two readers:
 *
 *   - the roles validator (CAP-2) — a `cardinality: many` role's `via:` must
 *     name a junction that exists and joins the right two entities;
 *   - `entity new`'s pre-flight (JUNC-0, #678) — every junction is mirrored onto
 *     both parents' service + module, rendered by the parents' own templates
 *     from the junction YAMLs. A junction file that fails the schema, or names
 *     an entity with no YAML, would otherwise drop (or break) that fan-out, so
 *     the pre-flight reports it instead of skipping it.
 */

import fs from 'node:fs';
import { deriveJunctionName } from '../schema/junction-definition.schema';
import type { JunctionSummary } from '../roles/validate-roles';
import { findYamlFiles } from '../utils/find-yaml-files';
import { detectYamlType, loadJunctionFromYaml } from '../utils/yaml-loader';

/** One junction file the loader could not accept. */
export interface JunctionLoadIssue {
	file: string;
	message: string;
	details?: string[];
}

export interface JunctionSet {
	/** Every valid junction, sorted by name, with the file that declares it. */
	junctions: Array<JunctionSummary & { file: string }>;
	/** Every junction file (`pattern: Junction`) that failed the schema. */
	issues: JunctionLoadIssue[];
}

/**
 * Every junction YAML under `dir` — a file whose top-level `pattern:` is
 * `Junction` — validated against `JunctionDefinitionSchema`. A missing
 * directory is an empty set: most projects have no junctions. Other YAML files
 * in the directory are not junctions and are ignored.
 */
export function loadJunctionSet(dir: string): JunctionSet {
	if (!fs.existsSync(dir)) return { junctions: [], issues: [] };
	const junctions: JunctionSet['junctions'] = [];
	const issues: JunctionLoadIssue[] = [];
	for (const file of findYamlFiles(dir)) {
		if (detectYamlType(file) !== 'junction') continue;
		const result = loadJunctionFromYaml(file);
		if (!result.success) {
			issues.push({ file, message: result.error, details: result.details });
			continue;
		}
		junctions.push({
			file,
			name: deriveJunctionName(result.definition),
			between: result.definition.between,
		});
	}
	return { junctions: junctions.sort((a, b) => a.name.localeCompare(b.name)), issues };
}

/**
 * The valid junctions under `dir` (the analyzer's view: an invalid junction
 * file is `junction new`'s and `entity new`'s to report).
 */
export function loadJunctionSummaries(dir: string): JunctionSummary[] {
	return loadJunctionSet(dir).junctions.map(({ name, between }) => ({ name, between }));
}

/**
 * The `entity new` pre-flight's junction rejections: every junction file that
 * fails the schema, and every valid junction whose `between:` names an entity
 * with no entity YAML (its fan-out would import a module that is never
 * generated). `entityNames` is every entity the project declares.
 */
export function junctionSetIssues(
	set: JunctionSet,
	entityNames: ReadonlySet<string>,
): JunctionLoadIssue[] {
	const issues = [...set.issues];
	for (const j of set.junctions) {
		const missing = j.between.filter((e) => !entityNames.has(e));
		if (missing.length === 0) continue;
		issues.push({
			file: j.file,
			message: `junction '${j.name}' names ${missing.map((e) => `'${e}'`).join(' and ')}, which no entity YAML declares`,
			details: [
				`between: [${j.between.join(', ')}] — both parents carry the junction's fan-out, so both must be entities of this project`,
			],
		});
	}
	return issues;
}
