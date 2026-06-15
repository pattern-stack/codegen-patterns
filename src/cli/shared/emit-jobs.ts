/**
 * Jobs emission write-orchestration (RFC-0005, breakdown #7b).
 *
 * Wraps the pure `generateJobHandler{Base,Subclass}` emitters with the file
 * layout + emit-once write logic — exactly as `emitAdapters` wraps the pure sink
 * generators. Per job, into `<backend_src>/jobs/`:
 *   - `<type>.job.generated.ts` — `@generated`, written via `writeIfChanged`
 *     (byte-idempotent; reflows on every run).
 *   - `<type>.job.ts` — emit-once: written only when absent (`existsSync`-skip),
 *     so author edits survive regen.
 *
 * The flat `<backend_src>/jobs/` layout is load-bearing: it is the same dir the
 * bridge-registry generator scans. Job triggers reach the bridge DECLARATIVELY
 * (RFC-0005 fork 1), so the emitted `@JobHandler` carries no `triggers` and the
 * scan never double-registers them.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeMode } from "./runtime-import";
import type { JobDefinition } from "../../schema/job-definition.schema";
import {
	generateJobHandlerBase,
	generateJobHandlerSubclass,
} from "./job-emission-generator";

export interface EmitJobsOptions {
	/** Validated job definitions (from `loadJobs`). */
	jobs: JobDefinition[];
	/** Absolute path to the handlers dir (`<cwd>/<backend_src>/jobs`). */
	jobsHandlersDir: string;
	/** Runtime mode (ADR-037). Default `package`. */
	mode?: RuntimeMode;
	/** If true, compute paths but don't write. */
	dryRun?: boolean;
}

export interface EmitJobsResult {
	/** `@generated` base file paths (always reflowed). */
	basesWritten: string[];
	/** Emit-once subclass paths written this run (were absent). */
	scaffoldsWritten: string[];
	/** Emit-once subclass paths skipped (already present). */
	scaffoldsSkipped: string[];
}

/** Byte-idempotent write — skips the disk write when content is unchanged. */
function writeIfChanged(outPath: string, content: string): void {
	if (existsSync(outPath) && statSync(outPath).isFile() && readFileSync(outPath, "utf-8") === content) {
		return;
	}
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, content);
}

function writeFresh(outPath: string, content: string): void {
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, content);
}

export function emitJobHandlers(opts: EmitJobsOptions): EmitJobsResult {
	const mode = opts.mode ?? "package";
	const result: EmitJobsResult = {
		basesWritten: [],
		scaffoldsWritten: [],
		scaffoldsSkipped: [],
	};

	for (const job of opts.jobs) {
		const basePath = join(opts.jobsHandlersDir, `${job.type}.job.generated.ts`);
		const subPath = join(opts.jobsHandlersDir, `${job.type}.job.ts`);

		// @generated base — always reflow.
		if (!opts.dryRun) writeIfChanged(basePath, generateJobHandlerBase({ job, mode }));
		result.basesWritten.push(basePath);

		// Emit-once subclass — write only when absent.
		if (existsSync(subPath)) {
			result.scaffoldsSkipped.push(subPath);
		} else {
			if (!opts.dryRun) writeFresh(subPath, generateJobHandlerSubclass({ job, mode }));
			result.scaffoldsWritten.push(subPath);
		}
	}

	return result;
}
