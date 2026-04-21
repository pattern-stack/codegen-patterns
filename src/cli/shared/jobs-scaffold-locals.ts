/**
 * Pure resolver for the Hygen locals consumed by `templates/subsystem/jobs/`.
 *
 * JOB-6: `subsystem install jobs` runs after `copyRuntime` and invokes the
 * jobs scaffold generator. The locals that steer the four templates
 * (worker.ejs.t, main-hook.ejs.t, codegen-config-jobs-block.ejs.t,
 * job-orchestration.schema.ejs.t) are computed by this function so the CLI
 * command stays thin and the logic stays unit-testable.
 *
 * This module is filesystem-unaware except via injected probes — callers
 * pass `fileExists(p)` rather than us reaching for `node:fs` directly. That
 * keeps the unit test suite pure (see cli-jobs-scaffold-locals.test.ts).
 */
import path from 'node:path';

import type { CodegenConfig } from './context.js';
import { resolveSubsystemsRootFromConfig } from './subsystems-path.js';

export interface JobsScaffoldLocals {
	/** Fallback basename for logs; not rendered in templates today. */
	appName: string;
	/** Documented default worker topology. */
	workerMode: 'embedded' | 'standalone';
	/** Gates the `tenantId` column in the schema template (Q1 2026-04-19). */
	multiTenant: boolean;
	/** Where `main-hook.ejs.t` injects the embedded-mode guidance block. */
	mainTsPath: string;
	/** Where `codegen-config-jobs-block.ejs.t` appends the `jobs:` block. */
	configPath: string;
	/** Existence check for the standalone worker entrypoint; used by `skip_if`. */
	workerExists: boolean;
	/** Where `worker.ejs.t` writes the worker bootstrap. */
	workerPath: string;
	/** Where `job-orchestration.schema.ejs.t` writes the scaffolded schema. */
	schemaPath: string;
	/** Sentinel-based idempotence flag for `main-hook.ejs.t`'s `skip_if`. */
	mainHookInjected: boolean;
}

export interface JobsScaffoldLocalsInput {
	/** Absolute working directory of the consumer project. */
	cwd: string;
	/** Parsed codegen.config.yaml (may be null on a brand-new init). */
	config: CodegenConfig | null;
	/** Injected fs probe. Implementations: `(p) => fs.existsSync(p)`. */
	fileExists: (absolutePath: string) => boolean;
	/** Injected fs read probe; returns null when the file is absent. */
	readFile: (absolutePath: string) => string | null;
}

/** Literal first line of the comment block emitted by `main-hook.ejs.t`. Must
 * match the template content exactly (including the em-dash) so re-running the
 * install detects the prior injection and skips. */
const MAIN_HOOK_SENTINEL = 'JOBS — Embedded worker mode (optional)';

/** Hygen front-matter treats any non-empty string as truthy for `skip_if`, so the
 * boolean-ish locals must render as the literal 'true' / empty string. EJS
 * serialises `Boolean` → 'true'/'false', so `skip_if: "false"` would also
 * evaluate truthy. Returning the boolean as the raw EJS expression value is
 * therefore unsafe; we stringify to '' when the worker doesn't exist. */
function workerSkipValue(exists: boolean): string {
	return exists ? 'true' : '';
}

/**
 * Resolve all Hygen locals for `subsystem install jobs` from config + cwd.
 *
 * - `jobs.multi_tenant` defaults to `false` when the block is absent (first
 *   install case). JOB-8 flips this to an opt-in toggle end-to-end.
 * - `worker_mode` mirrors the spec default (`embedded`).
 * - `schemaPath` resolves from `paths.subsystems` (or
 *   `<paths.backend_src>/shared/subsystems` when unset; see
 *   `subsystems-path.ts`), then appends `jobs/job-orchestration.schema.ts`
 *   — matching exactly the
 *   location `copyRuntime` would have emitted before we skipped that file.
 */
export function resolveJobsScaffoldLocals(
	input: JobsScaffoldLocalsInput,
): JobsScaffoldLocals {
	const { cwd, config, fileExists, readFile } = input;

	const jobsBlock = (config?.jobs ?? {}) as Record<string, unknown>;

	const subsystemsRoot = resolveSubsystemsRootFromConfig(cwd, config);

	const workerPath = path.resolve(cwd, 'worker.ts');
	const mainTsPath = path.resolve(cwd, 'src/main.ts');
	const configPath = path.resolve(cwd, 'codegen.config.yaml');
	const schemaPath = path.resolve(
		subsystemsRoot,
		'jobs',
		'job-orchestration.schema.ts',
	);

	const mainContent = readFile(mainTsPath);
	const mainHookInjected =
		mainContent !== null && mainContent.includes(MAIN_HOOK_SENTINEL);

	return {
		appName: path.basename(cwd),
		workerMode: normaliseWorkerMode(jobsBlock.worker_mode),
		multiTenant: normaliseMultiTenant(jobsBlock.multi_tenant),
		mainTsPath,
		configPath,
		workerExists: fileExists(workerPath),
		workerPath,
		schemaPath,
		mainHookInjected,
	};
}

function normaliseWorkerMode(raw: unknown): 'embedded' | 'standalone' {
	if (raw === 'standalone') return 'standalone';
	return 'embedded';
}

function normaliseMultiTenant(raw: unknown): boolean {
	return raw === true;
}

/**
 * Serialise locals to the `--flag value` argv pairs Hygen consumes. Booleans
 * become `'true'` / `'false'`; numeric / string values pass through. Paths
 * are forwarded as absolute so Hygen's `to:` front-matter resolves relative
 * to them, not to Hygen's `cwd`.
 */
export function localsToHygenArgs(locals: JobsScaffoldLocals): string[] {
	return [
		'--appName', locals.appName,
		'--workerMode', locals.workerMode,
		'--multiTenant', locals.multiTenant ? 'true' : 'false',
		'--mainTsPath', locals.mainTsPath,
		'--configPath', locals.configPath,
		'--workerExists', workerSkipValue(locals.workerExists),
		'--workerPath', locals.workerPath,
		'--schemaPath', locals.schemaPath,
		'--mainHookInjected', workerSkipValue(locals.mainHookInjected),
	];
}
