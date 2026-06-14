/**
 * Job Definition Loader (RFC-0005, breakdown #6)
 *
 * Loads and parses all job YAML files from a directory (default
 * `definitions/jobs/`). Enforces filename ↔ `type` consistency and rejects
 * duplicate job types. Returns a {@link LoadJobsResult} that collects all
 * issues (never throws), matching the `loadEvents()` / `loadEntities()`
 * contract used elsewhere in the parser layer.
 *
 * Deliberately does NOT cross-validate `triggers[].event` against the event
 * registry, nor arm `domain` against entities — those gen-time cross-refs are
 * the cross-ref validator's job (breakdown #8). This loader is shape + filename
 * + uniqueness only; #7 (the emitter) consumes the validated `JobDefinition[]`.
 */

import { basename, resolve } from 'node:path';
import { findYamlFiles } from '../utils/find-yaml-files';
import type { AnalysisIssue } from '../analyzer/types';
import type { JobDefinition } from '../schema/job-definition.schema';
import {
	loadJobFromYaml,
	type JobLoadError,
	type LoadJobResult,
} from '../utils/yaml-loader';

export interface LoadJobsResult {
	jobs: JobDefinition[];
	issues: AnalysisIssue[];
}

/**
 * Convert a job-load error result into one or more {@link AnalysisIssue}s.
 * Mirrors `loadErrorToIssue` in `load-events.ts` so CLI renderers treat both
 * loaders' output uniformly.
 */
function loadErrorToIssue(error: JobLoadError): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];

	issues.push({
		severity: 'error',
		type: 'parse_error',
		message: error.error,
		path: error.filePath,
	});

	if (error.details) {
		for (const detail of error.details) {
			issues.push({
				severity: 'error',
				type: 'schema_error',
				message: detail,
				path: error.filePath,
			});
		}
	}

	return issues;
}

/**
 * Strip `.yaml` / `.yml` from a filename.
 */
function stripYamlExt(file: string): string {
	const base = basename(file);
	if (base.endsWith('.yaml')) return base.slice(0, -'.yaml'.length);
	if (base.endsWith('.yml')) return base.slice(0, -'.yml'.length);
	return base;
}

/**
 * Load all job YAML files from a directory.
 *
 * - Nonexistent directory → non-fatal warning, returns empty list (jobs are
 *   opt-in, like providers — a project without `definitions/jobs/` is valid).
 * - Empty directory → warning, returns empty list.
 * - Per-file errors (YAML syntax, schema, filename mismatch, duplicate type)
 *   accumulate into {@link AnalysisIssue}s; no short-circuit.
 * - Never throws. Generator callers abort on `issues.some(i => i.severity === 'error')`.
 */
export function loadJobs(jobsDir: string): LoadJobsResult {
	const jobs: JobDefinition[] = [];
	const issues: AnalysisIssue[] = [];

	const resolvedDir = resolve(jobsDir);

	let files: string[];
	try {
		files = findYamlFiles(resolvedDir);
	} catch {
		issues.push({
			severity: 'warning',
			type: 'no_jobs_dir',
			message: `No jobs directory found at: ${resolvedDir}`,
			path: resolvedDir,
		});
		return { jobs, issues };
	}

	if (files.length === 0) {
		issues.push({
			severity: 'warning',
			type: 'no_files',
			message: `No job YAML files found in directory: ${resolvedDir}`,
			path: resolvedDir,
		});
		return { jobs, issues };
	}

	const seenTypes = new Map<string, string>(); // type → filePath of first definition

	for (const filePath of files) {
		const result: LoadJobResult = loadJobFromYaml(filePath);

		if (!result.success) {
			issues.push(...loadErrorToIssue(result));
			continue;
		}

		const { definition } = result;
		const baseName = stripYamlExt(filePath);

		// Filename ↔ type match. The job type IS the @JobHandler('<type>')
		// registry key; a drift between filename and type is a silent footgun.
		if (baseName !== definition.type) {
			issues.push({
				severity: 'error',
				type: 'job_filename_mismatch',
				message: `Job file '${baseName}' must contain 'type: ${baseName}' (found 'type: ${definition.type}')`,
				path: filePath,
				suggestion: `Rename the file to '${definition.type}.yaml' or fix the 'type' field to '${baseName}'`,
			});
			continue;
		}

		// Duplicate type detection (belt-and-braces — filename match usually
		// prevents this, but defend against symlinks / .yml vs .yaml twins).
		if (seenTypes.has(definition.type)) {
			issues.push({
				severity: 'error',
				type: 'duplicate_job_type',
				message: `Duplicate job type '${definition.type}' (already declared in ${seenTypes.get(definition.type)})`,
				path: filePath,
			});
			continue;
		}

		seenTypes.set(definition.type, filePath);
		jobs.push(definition);
	}

	return { jobs, issues };
}
