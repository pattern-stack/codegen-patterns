/**
 * `subsystem install identity` (ID-1): workspaces, membership and the requester, under `target.wiring: pattern-stack`.
 *
 * 1. The runtime: vendored (`runtime/subsystems/identity/` and its closure, the requester port included), or in
 *    package mode recorded under `subsystems.install`.
 * 2. The three entity YAMLs (`user`, `workspace`, `membership`) into `<entities>/identity/`. Then they are the project's.
 * 3. The `identity:` block, and `tenancy.column: workspace_id` when the project has no `tenancy:` block yet.
 * 4. The principal source (`<backend_src>/identity/principal-source.ts`): written once, then the author's.
 *
 * The composition (`entity new`) writes the `requester` system and the `workspaces` module from them.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Context } from './context.js';
import { projectLayout } from './project-layout.js';
import { copyRuntime } from './runtime-copier.js';
import { resolveRuntimeMode, subsystemCoreImport } from './runtime-import.js';
import { ensureSubsystemInstalled } from './subsystems-install-config.js';
import { entitiesDirPath } from '../../config/entities-dir.js';
import { configOrDefaults } from '../../config/project-config.js';
import { runtimeRoot } from './init-scaffold.js';
import { IDENTITY_DEFAULTS, WORKSPACE_SOURCE_NAMES, REQUESTER_CACHE_NAMES, REQUESTER_RESOLVER_NAMES } from '../../../runtime/subsystems/identity/names.js';
import { generating } from '../../utils/generated-file.js';

/** The tenant column identity's workspace is: every `tenant_scoped` entity points at it. */
export const IDENTITY_TENANT_COLUMN = 'workspace_id';

/** The entity YAMLs identity vendors, under `<entities>/identity/`. */
export const IDENTITY_ENTITY_FILES = ['user.yaml', 'workspace.yaml', 'membership.yaml'] as const;

/** Where the principal source lives in the project (emit-once, the author's). */
export function principalSourceFile(ctx: Pick<Context, 'cwd' | 'config'>): string {
	return path.join(projectLayout(ctx.cwd, ctx.config).backendSrc, 'identity', 'principal-source.ts');
}

function examplesRoot(): string {
	const pkgRoot = path.resolve(import.meta.dirname, '..', '..', '..');
	const topLevel = path.join(pkgRoot, 'examples', 'identity');
	return fs.existsSync(topLevel) ? topLevel : path.join(pkgRoot, 'dist', 'examples', 'identity');
}

/** The `identity:` block, its defaults written out with every row named, so the author sees what they can pick. */
export function identityConfigBlock(): string {
	return `
identity:
  # How a request names its workspace: ${WORKSPACE_SOURCE_NAMES.join(' | ')}.
  #   header — the X-Workspace header; path — /w/<workspace id>/… (ID-1).
  workspace_from: ${IDENTITY_DEFAULTS.workspace_from}
  requester:
    # How the requester is checked: ${REQUESTER_RESOLVER_NAMES.join(' | ')} (on every request, through the cache).
    resolver: ${IDENTITY_DEFAULTS.requester.resolver}
    # Where memberships are cached: ${REQUESTER_CACHE_NAMES.join(' | ')}.
    #   postgres — every process evicts on a NOTIFY sent in the change's transaction; memory — one process, tests.
    cache: ${IDENTITY_DEFAULTS.requester.cache}
`;
}

const TENANCY_BLOCK = `
tenancy:
  # ID-1: the workspace is the tenant, so every tenant_scoped entity points at it.
  column: ${IDENTITY_TENANT_COLUMN}
`;

/** The entity YAMLs (under `dir`, recursively) that declare `tenant_scoped:`. */
function tenantScopedYamls(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
		(f) => /\.ya?ml$/.test(f) && /^tenant_scoped:/m.test(fs.readFileSync(path.join(dir, f), 'utf8')),
	);
}

/** The principal source as written once. Lets nobody in until the app's sign-in (the next identity release) is bound. */
export function principalSourceScaffold(coreImport: string): string {
	return `// <CODEGEN-SCAFFOLD-V1>
// Scaffolded once by @pattern-stack/codegen (\`subsystem install identity\`), then yours. Re-running codegen detects the
// sentinel above and SKIPS this file.
import type { PrincipalSource } from '${coreImport}';

/**
 * Who a request is: the principal's id, or null when nobody is signed in. The \`requester\` system asks this first, then
 * checks the principal's membership in the workspace the request names.
 *
 * As written, nobody is signed in, so every request resolves \`unauthenticated\`. Bind your sign-in here. For local
 * development only, you can read a header instead:
 *
 *   principalOf: async (request) => request.header('X-Dev-Principal') ?? null,
 *
 * Never ship that: anyone can send the header.
 */
export const principalSource: PrincipalSource = {
  principalOf: async () => null,
};
`;
}

export interface IdentityInstallResult {
	written: string[];
	skipped: string[];
	notes: string[];
}

export async function installIdentity(
	ctx: Context,
	opts: { force: boolean; dryRun: boolean; configPath: string },
): Promise<IdentityInstallResult> {
	const layout = projectLayout(ctx.cwd, ctx.config);
	const mode = resolveRuntimeMode(ctx.config);
	const result: IdentityInstallResult = { written: [], skipped: [], notes: [] };
	const write = (file: string, content: string) => {
		if (fs.existsSync(file) && !opts.force) {
			result.skipped.push(file);
			return;
		}
		if (!opts.dryRun) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			generating(file, () => fs.writeFileSync(file, content));
		}
		result.written.push(file);
	};

	// 1. The runtime.
	if (mode === 'package') {
		if (!opts.dryRun) ensureSubsystemInstalled(opts.configPath, 'identity');
	} else {
		const copied = await copyRuntime({
			sourceDir: path.join(runtimeRoot(), 'subsystems', 'identity'),
			targetDir: path.join(layout.subsystems, 'identity'),
			resolveDeps: true,
			runtimeRoot: runtimeRoot(),
			depsTargetRoot: path.resolve(layout.subsystems, '..'),
			dryRun: opts.dryRun,
		});
		result.written.push(...copied.written, ...copied.updated, ...copied.dependenciesCopied);
	}

	// 2. The entity YAMLs.
	const entitiesDir = path.join(entitiesDirPath(ctx.cwd, configOrDefaults(ctx.config).paths), 'identity');
	for (const f of IDENTITY_ENTITY_FILES) {
		write(path.join(entitiesDir, f), fs.readFileSync(path.join(examplesRoot(), 'definitions', 'entities', 'identity', f), 'utf8'));
	}

	// 3. The config blocks. The tenant column is set only in a project with no tenant column in use yet: one whose
	// tenant_scoped entities already have their column keeps it (renaming it would drop and re-add every tenant column).
	const source = fs.existsSync(opts.configPath) ? fs.readFileSync(opts.configPath, 'utf8') : '';
	const scoped = tenantScopedYamls(path.dirname(entitiesDir));
	const setTenancy = !/^tenancy:/m.test(source) && scoped.length === 0;
	const appended = [...(/^identity:/m.test(source) ? [] : [identityConfigBlock()]), ...(setTenancy ? [TENANCY_BLOCK] : [])];
	const tenancyColumn = configOrDefaults(ctx.config).tenancy?.column;
	if (!setTenancy && tenancyColumn !== IDENTITY_TENANT_COLUMN) {
		result.notes.push(
			`tenancy.column is '${tenancyColumn}': tenant_scoped entities point at the workspace through it (identity names it ` +
				`'${IDENTITY_TENANT_COLUMN}' in a new project).`,
		);
	}
	if (appended.length > 0) {
		if (!opts.dryRun) fs.appendFileSync(opts.configPath, appended.join(''));
		result.written.push(opts.configPath);
	}

	// 4. The principal source: the author's once written, so never replaced, not even by --force.
	const principal = principalSourceFile(ctx);
	if (fs.existsSync(principal)) {
		result.skipped.push(principal);
	} else {
		if (!opts.dryRun) {
			fs.mkdirSync(path.dirname(principal), { recursive: true });
			fs.writeFileSync(principal, principalSourceScaffold(subsystemCoreImport(mode, 'identity')));
		}
		result.written.push(principal);
	}
	return result;
}
