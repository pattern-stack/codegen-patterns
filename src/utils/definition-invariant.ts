/**
 * The whole-set invariant (#915): every definition file a whole-set step reads
 * has already passed the pre-flight (`definitionSetRejections`). A step that
 * meets an invalid one anyway must not skip it — writing output over a set that
 * silently lacks a definition is an absent input defaulting to permissive.
 * It throws, naming the file and its first issue.
 */

import { existsSync } from 'node:fs';
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
 * Throw on the first error-severity load issue (`loadEntities` /
 * `loadEntityRegistry`) that names a definition FILE, and on a directory that
 * exists but cannot be read (EACCES, ENOTDIR): that is not an empty set. A
 * directory that does not exist is the empty set and stays the caller's to read.
 */
export function assertNoInvalidDefinitions(issues: readonly AnalysisIssue[]): void {
	for (const i of issues) {
		if (i.severity !== 'error' || !i.path) continue;
		if (/\.ya?ml$/.test(i.path)) throw new InvalidDefinitionError(i.path, i.message);
		// The one exemption: the directory itself does not exist (an empty set). One that
		// exists and cannot be read (EACCES, ENOTDIR) is not.
		if (i.type === 'parse_error' && existsSync(i.path)) {
			throw new Error(`${i.message} — a definitions directory that exists but cannot be read is not an empty set`);
		}
	}
}

/**
 * A file under `relationships/` the whole-set steps must treat as a relationship
 * definition and that fails to load: one declaring `relationship:` that fails the
 * schema, or one that does not parse at all. Any other kind of file is not a
 * relationship and is not read. Shared by the pre-flight and the loaders so the
 * two cannot disagree about which files count.
 */
export function relationshipFileFailure(
	file: string,
	explicit = false,
	loaded: ReturnType<typeof loadRelationshipFromYaml> = loadRelationshipFromYaml(file),
): LoadError | null {
	const result = loaded;
	if (result.success) return null;
	if (explicit || detectYamlType(file) === 'relationship' || result.error.startsWith('Invalid YAML')) {
		return result;
	}
	return null;
}
