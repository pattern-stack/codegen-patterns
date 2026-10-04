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
import { basename, dirname, extname, join } from "node:path";
import { generating } from "../../utils/generated-file";
import type { AnalysisIssue } from "../../analyzer/types";
import type { RuntimeMode } from "./runtime-import";
import type { JobArm, JobDefinition } from "../../schema/job-definition.schema";
import type { SubsystemName } from "./subsystem-detect";
import { issueRejections } from "./run-rejections";
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
	writeFresh(outPath, content);
}

function writeFresh(outPath: string, content: string): void {
	generating(outPath, () => {
		mkdirSync(dirname(outPath), { recursive: true });
		writeFileSync(outPath, content);
	});
}

/** One job YAML `entity new` rejects, in the CLI-0 rejection-list shape. */
export interface JobLoadRejection {
	/** The job YAML; `null` for an issue `loadJobs` did not attach to a file. */
	file: string | null;
	message: string;
	details: string[];
}

/**
 * `loadJobs` error issues → one rejection per job YAML (JOBS-2, #664): the
 * file, its first error as the message, the rest as details. A job YAML that
 * no longer loads contributes nothing to this run, but a
 * `<type>.job.generated.ts` a previous run emitted from it stays on disk (no
 * rollback — an author may be mid-edit, and the subclass beside it is theirs);
 * the rejection names that file so the author knows it is stale.
 */
export function jobLoadRejections(
	issues: AnalysisIssue[],
	jobsHandlersDir: string,
): JobLoadRejection[] {
	return issueRejections(issues).map(({ file, message, details }) => {
		// No file, no base to name: a stale path is derived from the YAML's name.
		if (file !== null) {
			const staleBase = join(
				jobsHandlersDir,
				`${basename(file, extname(file))}.job.generated.ts`,
			);
			if (existsSync(staleBase)) {
				details.push(
					`${staleBase} is stale: emitted from this job's last valid definition, it is left on disk until the YAML loads again`,
				);
			}
		}
		return { file, message, details };
	});
}

/**
 * Jobs whose handler base would import a subsystem the project has not
 * installed → one run-level rejection per job (#745). Every arm kind embeds a
 * `read:` `DetectionConfig`, and the `@generated` base types its per-arm
 * detection literals against the integration subsystem's barrel, so without it
 * the consumer's `tsc` fails TS2307 (vendored) or the job runs with no
 * `IntegrationModule` wired (package). `installed` is the mode-aware set
 * `resolveInstalledSubsystems` returns — the same one the subsystem barrel
 * composes from.
 */
export function jobSubsystemRejections(
	jobs: JobDefinition[],
	installed: ReadonlySet<SubsystemName>,
	jobsDir: string,
): JobLoadRejection[] {
	if (installed.has("integration")) return [];
	return jobs.flatMap((job) => {
		const [first, ...rest] = job.arms;
		if (first === undefined) return [];
		const missing = (arm: JobArm) =>
			`job '${job.type}' arm '${arm.domain}' (kind: ${arm.kind}) has a \`read:\` block, which types against the integration subsystem — not installed. Run \`codegen subsystem install integration\`.`;
		return [
			{
				file: join(jobsDir, `${job.type}.yaml`),
				message: missing(first),
				details: rest.map(missing),
			},
		];
	});
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
