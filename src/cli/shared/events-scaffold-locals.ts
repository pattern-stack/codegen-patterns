/**
 * Pure resolver for the Hygen locals consumed by `templates/subsystem/events/`.
 *
 * EVT-8: `subsystem install events` runs after `copyRuntime` and invokes the
 * events scaffold generator. The three templates this steers:
 *   - `codegen-config-events-block.ejs.t` — appends the `events:` block.
 *   - `domain-events.schema.ejs.t` — writes the outbox schema, gating the
 *     `tenantId` column on `events.multi_tenant`.
 *   - `generated-keep.ejs.t` — writes a `.gitkeep` under `generated/` so the
 *     directory exists before `just gen-all` produces the typed artifacts.
 *
 * Mirrors `jobs-scaffold-locals.ts` minus the worker-specific fields. Events
 * has no separate worker process — the drain loop runs wherever
 * `EventsModule.forRoot(...)` is imported.
 *
 * This module is filesystem-unaware except via injected probes — callers
 * pass `fileExists(p)` rather than us reaching for `node:fs` directly. That
 * keeps the unit test suite pure (see cli/events-scaffold-locals.test.ts).
 */
import path from 'node:path';

import type { CodegenConfig } from './context.js';
import { resolveSubsystemsRootFromConfig } from './subsystems-path.js';

export interface EventsScaffoldLocals {
	/** Fallback basename for logs; not rendered in templates today. */
	appName: string;
	/** Gates the `tenantId` column in the schema template. */
	multiTenant: boolean;
	/** Where `codegen-config-events-block.ejs.t` appends the `events:` block. */
	configPath: string;
	/** Where `domain-events.schema.ejs.t` writes the scaffolded schema. */
	schemaPath: string;
	/** Where `generated-keep.ejs.t` writes the `.gitkeep` stub. */
	generatedKeepPath: string;
}

export interface EventsScaffoldLocalsInput {
	/** Absolute working directory of the consumer project. */
	cwd: string;
	/** Parsed codegen.config.yaml (may be null on a brand-new init). */
	config: CodegenConfig | null;
	/** Injected fs probe. Implementations: `(p) => fs.existsSync(p)`. */
	fileExists: (absolutePath: string) => boolean;
}

/**
 * Resolve all Hygen locals for `subsystem install events` from config + cwd.
 *
 * - `events.multi_tenant` defaults to `false` when the block is absent (first
 *   install case). Only the literal `true` flips the flag — defends against
 *   YAML truthy surprises like `'yes'` / `1`.
 * - `schemaPath` resolves from `paths.subsystems` (or
 *   `<paths.backend_src>/shared/subsystems` when unset; see
 *   `subsystems-path.ts`), then appends `events/domain-events.schema.ts`
 *   — matching exactly the
 *   location `copyRuntime` would have emitted before we skipped that file.
 * - `generatedKeepPath` sits under the same subsystems root as
 *   `events/generated/.gitkeep` so `just gen-all` has a committed directory
 *   to drop the typed artifacts into.
 *
 * The `fileExists` probe is a reserved capability — today's templates don't
 * consume any existence checks (config and schema use `inject` + `force`
 * respectively, the keep file uses `unless_exists`). The parameter is kept
 * for parity with the jobs resolver and for future probes without an API
 * break.
 */
export function resolveEventsScaffoldLocals(
	input: EventsScaffoldLocalsInput,
): EventsScaffoldLocals {
	const { cwd, config } = input;
	// fileExists is intentionally unused — see JSDoc. Touch the reference so
	// tree-shaking / lint doesn't complain.
	void input.fileExists;

	const eventsBlock = (config?.events ?? {}) as Record<string, unknown>;

	const subsystemsRoot = resolveSubsystemsRootFromConfig(cwd, config);

	const configPath = path.resolve(cwd, 'codegen.config.yaml');
	const schemaPath = path.resolve(
		subsystemsRoot,
		'events',
		'domain-events.schema.ts',
	);
	const generatedKeepPath = path.resolve(
		subsystemsRoot,
		'events',
		'generated',
		'.gitkeep',
	);

	return {
		appName: path.basename(cwd),
		multiTenant: normaliseMultiTenant(eventsBlock.multi_tenant),
		configPath,
		schemaPath,
		generatedKeepPath,
	};
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
export function localsToHygenArgs(locals: EventsScaffoldLocals): string[] {
	return [
		'--appName', locals.appName,
		'--multiTenant', locals.multiTenant ? 'true' : 'false',
		'--configPath', locals.configPath,
		'--schemaPath', locals.schemaPath,
		'--generatedKeepPath', locals.generatedKeepPath,
	];
}
