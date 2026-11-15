/**
 * The whole-set invariant (#915): every definition file a whole-set step reads
 * has already passed the pre-flight (`definitionSetRejections`). A step that
 * meets an invalid one anyway must not skip it — writing output over a set that
 * silently lacks a definition is an absent input defaulting to permissive.
 * It throws, naming the file and its first issue.
 */

import path from 'node:path';

import type { AnalysisIssue } from '../analyzer/types.js';
import { detectYamlType, loadRelationshipFromYaml, type LoadError } from './yaml-loader.js';

export class InvalidDefinitionError extends Error {
	constructor(
		readonly file: string,
		reason: string,
	) {
		super(
			`${path.basename(file)} — reached a whole-set step with an invalid definition ` +
				`(the pre-flight should have stopped it): ${reason}`,
		);
		this.name = 'InvalidDefinitionError';
	}
}

/** The error for a definition file that failed to load: its message and first issue. */
export function invalidDefinitionError(
	failure: Pick<LoadError, 'filePath' | 'error' | 'details'>,
): InvalidDefinitionError {
	const first = failure.details?.[0];
	return new InvalidDefinitionError(failure.filePath, first ? `${failure.error} — ${first}` : failure.error);
}

/**
 * Throw on the first error-severity load issue that names a definition FILE
 * (`loadEntities` / `loadEntityRegistry`). An issue naming the directory (it
 * does not exist: an empty set) is not an invalid definition and stays the
 * caller's to read.
 */
export function assertNoInvalidDefinitions(issues: readonly AnalysisIssue[]): void {
	const first = issues.find((i) => i.severity === 'error' && i.path && /\.ya?ml$/.test(i.path));
	if (first) throw new InvalidDefinitionError(first.path!, first.message);
}

/**
 * A file under `relationships/` the whole-set steps must treat as a relationship
 * definition and that fails to load: one declaring `relationship:` that fails the
 * schema, or one that does not parse at all. Any other kind of file is not a
 * relationship and is not read. Shared by the pre-flight and the loaders so the
 * two cannot disagree about which files count.
 */
export function relationshipFileFailure(file: string, explicit = false): LoadError | null {
	const result = loadRelationshipFromYaml(file);
	if (result.success) return null;
	if (explicit || detectYamlType(file) === 'relationship' || result.error.startsWith('Invalid YAML')) {
		return result;
	}
	return null;
}
