/**
 * Pre-flight rejections — one implementation for every command that refuses to
 * write from a broken input (CLI-0 #627, JOBS-2 #664, CLI-1).
 *
 * A rejection is `{ file, message, details }`: printed in every mode (text:
 * `printError` `<basename> — <message>`, one bullet per detail; JSON mode prints
 * nothing on stderr and carries it), and, when the command stops on it, reported
 * as the `stopped: 'pre-flight'` payload. `entity new` collects per-entity
 * rejections (schema, `emits:`, `roles:`) and run-level ones (job YAML, app
 * pattern file, provider YAML); `orchestration gen` collects pattern files.
 */

import path from 'node:path';

import type { AnalysisIssue } from '../../analyzer/types.js';
import { printError } from '../ui/output.js';
import { isJsonMode, printJson } from '../ui/json.js';

/** One rejected input. `file` is `null` only for an issue no file carries. */
export interface RunRejection {
	file: string | null;
	message: string;
	details?: string[];
}

/** One failed target, as a `--json` payload reports it. */
export interface RejectionEntry {
	name: string | null;
	file: string | null;
	message: string;
	details: string[];
}

export function rejectionEntry(r: RunRejection): RejectionEntry {
	return {
		name: r.file === null ? null : path.basename(r.file),
		file: r.file,
		message: r.message,
		details: r.details ?? [],
	};
}

/**
 * Error-severity issues → one rejection per file (`issue.path`): the file's
 * first issue is the message, the rest are details. An issue with no path
 * groups under `file: null`.
 */
export function issueRejections(issues: AnalysisIssue[]): Array<RunRejection & { details: string[] }> {
	const byFile = new Map<string | null, string[]>();
	for (const issue of issues) {
		if (issue.severity !== 'error') continue;
		const file = issue.path ?? null;
		const reasons = byFile.get(file) ?? [];
		reasons.push(issue.message);
		byFile.set(file, reasons);
	}
	return [...byFile].map(([file, reasons]) => ({
		file,
		message: reasons[0]!,
		details: reasons.slice(1),
	}));
}

/** Print each rejection (text mode; the output helpers are no-ops in JSON mode). */
export function printRejections(rejections: RunRejection[]): void {
	for (const r of rejections) {
		printError(r.file === null ? r.message : `${path.basename(r.file)} — ${r.message}`);
		for (const detail of r.details ?? []) {
			printError(`   • ${detail}`);
		}
	}
}

/**
 * The command stopped in its pre-flight: JSON mode gets
 * `{ command, stopped: 'pre-flight', totals, succeeded: [], failed }` (text mode
 * already printed the rejections). Returns the exit code, `1`.
 */
export function reportPreflightStop(command: string, rejections: RunRejection[]): 1 {
	if (isJsonMode()) {
		printJson({
			command,
			stopped: 'pre-flight',
			totals: { succeeded: 0, failed: rejections.length },
			succeeded: [],
			failed: rejections.map(rejectionEntry),
		});
	}
	return 1;
}
