/**
 * Pure resolver for the Hygen locals consumed by `templates/subsystem/integration/`.
 *
 * SYNC-7: `subsystem install integration` runs after `copyRuntime` and invokes the
 * integration scaffold generator. The two templates this steers:
 *   - `codegen-config-integration-block.ejs.t` — appends the `integration:` block.
 *   - `integration-audit.schema.ejs.t` — writes the three-table audit schema,
 *     gating the `tenant_id` columns on `integration.multi_tenant`.
 *
 * Integration intentionally has NO `generated/` directory — unlike events (which
 * codegen-emits `TypedEventBus`), integration has no typed artifacts to stage.
 * The orchestrator + differ are directly importable; consumers override
 * the differ by binding a different `IFieldDiffer<T>` to `INTEGRATION_FIELD_DIFFER`.
 * A future Phase-2 `integrationable:` YAML flag (see epic #60) may add a
 * `generated/` dir then; skipping it now avoids shipping a phantom
 * directory. Matches the "don't design for hypothetical future
 * requirements" line in CLAUDE.md.
 *
 * This module is filesystem-unaware except via injected probes — callers
 * pass `fileExists(p)` rather than us reaching for `node:fs` directly. That
 * keeps the unit test suite pure (see cli/integration-scaffold-locals.test.ts).
 */
import path from 'node:path';

import type { CodegenConfig } from './context.js';
import { resolveSubsystemsRootFromConfig } from './subsystems-path.js';

export interface IntegrationScaffoldLocals {
	/** Fallback basename for logs; not rendered in templates today. */
	appName: string;
	/** Gates the `tenant_id` columns in the schema template. */
	multiTenant: boolean;
	/** Where `codegen-config-integration-block.ejs.t` appends the `integration:` block. */
	configPath: string;
	/** Where `integration-audit.schema.ejs.t` writes the scaffolded schema. */
	schemaPath: string;
}

export interface IntegrationScaffoldLocalsInput {
	/** Absolute working directory of the consumer project. */
	cwd: string;
	/** Parsed codegen.config.yaml (may be null on a brand-new init). */
	config: CodegenConfig | null;
	/** Injected fs probe. Implementations: `(p) => fs.existsSync(p)`. */
	fileExists: (absolutePath: string) => boolean;
}

/**
 * Resolve all Hygen locals for `subsystem install integration` from config + cwd.
 *
 * - `integration.multi_tenant` defaults to `false` when the block is absent (first
 *   install case). Only the literal `true` flips the flag — defends against
 *   YAML truthy surprises like `'yes'` / `1`.
 * - `schemaPath` resolves from `paths.subsystems` (or
 *   `<paths.backend_src>/shared/subsystems` when unset; see
 *   `subsystems-path.ts`), then appends `integration/integration-audit.schema.ts` —
 *   matching exactly the location `copyRuntime` would have emitted before
 *   we skipped that file via `backendFileFilter`.
 *
 * The `fileExists` probe is a reserved capability — today's templates
 * don't consume any existence checks (config and schema use `inject` +
 * `force` respectively). The parameter is kept for parity with the
 * events/jobs resolvers and for future probes without an API break.
 */
export function resolveIntegrationScaffoldLocals(
	input: IntegrationScaffoldLocalsInput,
): IntegrationScaffoldLocals {
	const { cwd, config } = input;
	// fileExists is intentionally unused — see JSDoc. Touch the reference
	// so tree-shaking / lint doesn't complain.
	void input.fileExists;

	const integrationBlock = (config?.integration ?? {}) as Record<string, unknown>;

	const subsystemsRoot = resolveSubsystemsRootFromConfig(cwd, config);

	const configPath = path.resolve(cwd, 'codegen.config.yaml');
	const schemaPath = path.resolve(
		subsystemsRoot,
		'integration',
		'integration-audit.schema.ts',
	);

	return {
		appName: path.basename(cwd),
		multiTenant: normaliseMultiTenant(integrationBlock.multi_tenant),
		configPath,
		schemaPath,
	};
}

function normaliseMultiTenant(raw: unknown): boolean {
	return raw === true;
}

/**
 * Serialise locals to the `--flag value` argv pairs Hygen consumes.
 * Booleans become `'true'` / `'false'`; string values pass through. Paths
 * are forwarded as absolute so Hygen's `to:` front-matter resolves
 * relative to them, not to Hygen's `cwd`.
 */
export function localsToHygenArgs(locals: IntegrationScaffoldLocals): string[] {
	return [
		'--appName', locals.appName,
		'--multiTenant', locals.multiTenant ? 'true' : 'false',
		'--configPath', locals.configPath,
		'--schemaPath', locals.schemaPath,
	];
}
