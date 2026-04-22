/**
 * Pure resolver for the Hygen locals consumed by `templates/subsystem/bridge/`.
 *
 * BRIDGE-9: `subsystem install bridge` runs after `copyRuntime` and invokes
 * the bridge scaffold generator. The bridge follows the LEAN scaffold
 * pattern (lead-approved, deviation from BRIDGE-9 spec's 13-template list):
 *
 *   - The bridge runtime is bulk-copied via `runtime-copier.ts` like every
 *     other subsystem. Templates only exist for what cannot flow through
 *     `copyRuntime`:
 *       1. `generated-keep.ejs.t` — emits a `.gitkeep` so cold clones can
 *          build before `just gen-all` runs and produces `registry.ts`.
 *       2. `codegen-config-bridge-block.ejs.t` (in `bridge-config/`) —
 *          injects the `bridge:` block into `codegen.config.yaml`.
 *
 * Unlike events / sync, there is NO schema template: per BRIDGE-1 the
 * `tenant_id` column on `bridge_delivery` is unconditionally emitted (the
 * column is always present in the schema; the multi-tenancy *runtime
 * enforcement* is what `multi_tenant: true` in config toggles). So the
 * `bridge-delivery.schema.ts` runtime file flows through `copyRuntime`
 * untouched — no skip-list entry, no Hygen template.
 *
 * Mirrors `events-scaffold-locals.ts` minus the schema field; bridge has
 * no separate worker process — drain integration runs wherever
 * `EventsModule` is mounted; the wrapper handler runs wherever
 * `JobWorkerModule` polls a reserved bridge pool.
 */
import path from 'node:path';

import type { CodegenConfig } from './context.js';
import { resolveSubsystemsRootFromConfig } from './subsystems-path.js';

export interface BridgeScaffoldLocals {
	/** Fallback basename for logs; not rendered in templates today. */
	appName: string;
	/**
	 * Reserved local for parity with events / sync. Bridge multi-tenancy is
	 * a runtime concern (BridgeModule.forRoot({ multiTenant })) — no
	 * scaffold-time schema branching today. Kept so the locals shape stays
	 * stable if a future template needs to gate something.
	 */
	multiTenant: boolean;
	/** Where `codegen-config-bridge-block.ejs.t` appends the `bridge:` block. */
	configPath: string;
	/** Where `generated-keep.ejs.t` writes the `.gitkeep` stub. */
	generatedKeepPath: string;
}

export interface BridgeScaffoldLocalsInput {
	/** Absolute working directory of the consumer project. */
	cwd: string;
	/** Parsed codegen.config.yaml (may be null on a brand-new init). */
	config: CodegenConfig | null;
	/** Injected fs probe. Implementations: `(p) => fs.existsSync(p)`. */
	fileExists: (absolutePath: string) => boolean;
}

/**
 * Resolve all Hygen locals for `subsystem install bridge` from config + cwd.
 *
 * - `bridge.multi_tenant` defaults to `false` when the block is absent.
 *   Only the literal `true` flips the flag — defends against YAML truthy
 *   surprises.
 * - `generatedKeepPath` sits under the same subsystems root as
 *   `bridge/generated/.gitkeep` so the output dir for
 *   `bridge-registry-generator.ts` exists in source control.
 *
 * The `fileExists` probe is reserved (parity with events / sync) — today's
 * templates use `unless_exists` / `inject` and don't need an existence
 * check from the resolver.
 */
export function resolveBridgeScaffoldLocals(
	input: BridgeScaffoldLocalsInput,
): BridgeScaffoldLocals {
	const { cwd, config } = input;
	void input.fileExists;

	const bridgeBlock = (config?.bridge ?? {}) as Record<string, unknown>;

	const subsystemsRoot = resolveSubsystemsRootFromConfig(cwd, config);

	const configPath = path.resolve(cwd, 'codegen.config.yaml');
	const generatedKeepPath = path.resolve(
		subsystemsRoot,
		'bridge',
		'generated',
		'.gitkeep',
	);

	return {
		appName: path.basename(cwd),
		multiTenant: normaliseMultiTenant(bridgeBlock.multi_tenant),
		configPath,
		generatedKeepPath,
	};
}

function normaliseMultiTenant(raw: unknown): boolean {
	return raw === true;
}

/**
 * Serialise locals to the `--flag value` argv pairs Hygen consumes.
 * Booleans become `'true'` / `'false'`; paths are forwarded as absolute so
 * Hygen's `to:` front-matter resolves relative to them, not Hygen's `cwd`.
 */
export function localsToHygenArgs(locals: BridgeScaffoldLocals): string[] {
	return [
		'--appName', locals.appName,
		'--multiTenant', locals.multiTenant ? 'true' : 'false',
		'--configPath', locals.configPath,
		'--generatedKeepPath', locals.generatedKeepPath,
	];
}
