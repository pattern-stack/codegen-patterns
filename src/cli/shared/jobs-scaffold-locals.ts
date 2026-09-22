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
import { importSpecifier, projectLayout } from './project-layout.js';
import { resolveRuntimeMode, runtimeImport } from './runtime-import.js';

export interface JobsScaffoldLocals {
	/** Fallback basename for logs; not rendered in templates today. */
	appName: string;
	/** Gates the `tenantId` column in the schema template (Q1 2026-04-19). */
	multiTenant: boolean;
	/** Where `main-hook.ejs.t` injects the embedded-mode guidance block. */
	mainTsPath: string;
	/** Where `codegen-config-jobs-block.ejs.t` appends the `jobs:` block. */
	configPath: string;
	/** Existence check for the standalone worker entrypoint; used by `skip_if`. */
	workerExists: boolean;
	/** Where `worker.ejs.t` writes the worker bootstrap. Sits at `src/worker.ts`
	 * (next to `app.module.ts`) so it lands inside the default tsconfig include
	 * and the relative `./app.module` import resolves (#513). */
	workerPath: string;
	/** Mode-aware import specifier for `JobWorkerModule` (ADR-037, #513). Package
	 * mode → `@pattern-stack/codegen/runtime/subsystems/jobs/index`; vendored →
	 * `@shared/subsystems/jobs/index`. The only mode-dependent import the worker
	 * carries — `AppModule` is imported relatively. */
	jobWorkerModuleImport: string;
	/** `<generated>/app-config` as imported from `worker.ts`, for the
	 * `jobWorkerOptions` the worker passes to `JobWorkerModule.forRoot` (GEN-0,
	 * #652 — the emit-once worker carries no config value). */
	appConfigImport: string;
	/** Where `job-orchestration.schema.ejs.t` writes the scaffolded schema. */
	schemaPath: string;
	/** Sentinel-based idempotence flag for `main-hook.ejs.t`'s `skip_if`. */
	mainHookInjected: boolean;
	/** #517 — skips `job-orchestration.schema.ejs.t` in package mode. Package
	 * mode's schema story is `regenerateSubsystemSchemaBarrel` (the schema ships
	 * in the published package and is re-exported from `<generated>/
	 * subsystems-schema.ts`), so vendoring a templated copy into the consumer
	 * tree would be a duplicate. Vendored mode keeps the template as the sole
	 * tenancy-aware emitter. Boolean-ish for `skip_if` — see `workerSkipValue`. */
	skipSchema: boolean;
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
 * - No template reads `worker_mode`: the composition is the barrel's, from the
 *   schema's one default (JOBS-1, #659).
 * - `schemaPath` resolves from the subsystems root
 *   (`<paths.backend_src>/shared/subsystems`; see `project-layout.ts`),
 *   then appends `jobs/job-orchestration.schema.ts`
 *   — matching exactly the
 *   location `copyRuntime` would have emitted before we skipped that file.
 */
export function resolveJobsScaffoldLocals(
	input: JobsScaffoldLocalsInput,
): JobsScaffoldLocals {
	const { cwd, config, fileExists, readFile } = input;

	const jobsBlock = (config?.jobs ?? {}) as Record<string, unknown>;

	const layout = projectLayout(cwd, config);
	const subsystemsRoot = layout.subsystems;

	// #513: the worker sits at `<backend_src>/worker.ts`, next to
	// `app.module.ts` — inside the backend tsconfig `include`, and where the
	// relative `./app.module` import the AppModule-composition (D1) needs
	// resolves. Sibling of `main.ts` (#566: both from `paths.backend_src`).
	const workerPath = layout.workerTs;
	const mainTsPath = layout.mainTs;
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
		multiTenant: normaliseMultiTenant(jobsBlock.multi_tenant),
		mainTsPath,
		configPath,
		workerExists: fileExists(workerPath),
		workerPath,
		jobWorkerModuleImport: resolveJobWorkerModuleImport(config),
		appConfigImport: importSpecifier(workerPath, path.join(layout.generated, 'app-config')),
		schemaPath,
		mainHookInjected,
		// #517 — in package mode the schema ships in the package (consumed via the
		// schema barrel), so the template is skipped; vendored mode renders it.
		skipSchema: resolveRuntimeMode(config) === 'package',
	};
}

/**
 * #513 — resolve the mode-aware `JobWorkerModule` import for the standalone
 * worker (ADR-037). Routes through the shared `runtimeImport` resolver against
 * `subsystems/jobs/index` (NOT the top-level `/subsystems` barrel, which
 * re-exports only `EventsModule` in package mode — see `makeModuleImport`):
 *   - package  → `@pattern-stack/codegen/runtime/subsystems/jobs/index`
 *   - vendored → `@shared/subsystems/jobs/index`
 */
function resolveJobWorkerModuleImport(config: CodegenConfig | null): string {
	return runtimeImport(resolveRuntimeMode(config), 'subsystems/jobs/index');
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
		'--multiTenant', locals.multiTenant ? 'true' : 'false',
		'--mainTsPath', locals.mainTsPath,
		'--configPath', locals.configPath,
		'--workerExists', workerSkipValue(locals.workerExists),
		'--workerPath', locals.workerPath,
		'--jobWorkerModuleImport', locals.jobWorkerModuleImport,
		'--appConfigImport', locals.appConfigImport,
		'--schemaPath', locals.schemaPath,
		'--mainHookInjected', workerSkipValue(locals.mainHookInjected),
		// #517 — boolean-ish for `skip_if` (same '' / 'true' encoding as
		// workerExists / mainHookInjected). 'true' in package mode → the schema
		// template is skipped (the package ships the schema).
		'--skipSchema', workerSkipValue(locals.skipSchema),
	];
}

/** The call a current `worker.ts` makes (GEN-0, #652). */
const CURRENT_WORKER_CALL = 'JobWorkerModule.forRoot(jobWorkerOptions)';
/** That call as a line of code — the template's doc comment names it too. */
const CURRENT_WORKER_CALL_LINE = /^\s*JobWorkerModule\.forRoot\(jobWorkerOptions\)/m;

/**
 * GEN-0 (#652) — a `worker.ts` emitted before GEN-0 bakes `jobs.backend` /
 * `jobs.extensions.*` into its `JobWorkerModule.forRoot({ … })` literal, so
 * later config edits never reach it. The file is emit-once and consumer-owned:
 * no codemod rewrites it (I7). Returns the one-time manual edit when `content`
 * lacks the current call, else null.
 */
export function staleWorkerNotice(
	content: string,
	workerPath: string,
	appConfigImport: string,
): string | null {
	if (CURRENT_WORKER_CALL_LINE.test(content)) return null;
	return [
		`${workerPath} predates GEN-0 (#652): its JobWorkerModule.forRoot({ … }) options were fixed at install, so later jobs.backend / jobs.extensions edits never reach it. One-time edit:`,
		`  import { jobWorkerOptions } from '${appConfigImport}';   // replaces any \`import { jobPools } …\``,
		`  ${CURRENT_WORKER_CALL},   // replaces JobWorkerModule.forRoot({ mode: 'standalone', … })`,
	].join('\n');
}
