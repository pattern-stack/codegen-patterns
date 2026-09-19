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
	/** Every file under the directory that is not a valid junction. */
	issues: JunctionLoadIssue[];
}

/**
 * Every YAML under `dir`, validated against `JunctionDefinitionSchema`. The
 * directory holds junctions only: a file that does not parse, or is not
 * `pattern: Junction`, is an issue — never skipped. A missing directory is an
 * empty set: most projects have no junctions.
 */
export function loadJunctionSet(dir: string): JunctionSet {
	if (!fs.existsSync(dir)) return { junctions: [], issues: [] };
	const junctions: JunctionSet['junctions'] = [];
	const issues: JunctionLoadIssue[] = [];
	for (const file of findYamlFiles(dir)) {
		const result = loadJunctionFromYaml(file);
		if (!result.success) {
			// Unparseable, or parsed but not `pattern: Junction` (a typo such as
			// `pattern: junction` included): skipping it would silently drop the
			// junction's fan-out from both parents — the #678 defect class.
			const notAJunction = detectYamlType(file) !== 'junction' && !result.error.startsWith('Invalid YAML');
			issues.push({
				file,
				message: notAJunction
					? 'not a junction definition — every YAML under junctions/ must declare top-level `pattern: Junction`'
					: result.error,
				details: result.details,
			});
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
