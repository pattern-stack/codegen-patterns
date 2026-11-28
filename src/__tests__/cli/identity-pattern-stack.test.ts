/**
 * Identity under `wiring: pattern-stack` (ID-1): the install (runtime, YAMLs, config block, tenant column, the principal
 * source kept once written) and the composition (the `requester` system, the `workspaces` module, their refusals).
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installIdentity, principalSourceScaffold } from '../../cli/shared/identity-install';
import { patternStackSubsystemRefusal } from '../../cli/shared/pattern-stack-subsystems';
import { loadProjectApiContext } from '../../derived/api/project';
import { planComposition, type CompositionIdentityInput } from '../../emitters/composition/emit-composition';
import { ROLES } from '../../../runtime/subsystems/identity/names';
import { CodegenConfigSchema } from '../../schema/codegen-config.schema';
import { parse as parseYaml } from 'yaml';

/** The context the CLI passes: the project's config, parsed (defaults filled). */
const contextOf = (cwd: string) =>
	({ cwd, config: CodegenConfigSchema.parse(parseYaml(fs.readFileSync(path.join(cwd, 'codegen.config.yaml'), 'utf8'))) }) as never;

const REPO = path.resolve(import.meta.dir, '../../..');
const ROOT = '/app/src';

const TARGET = 'runtime: vendored\ntarget:\n  database: postgres\n  orm: drizzle\n  wiring: pattern-stack\n  http: none\n';

function project(config = TARGET) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-install-'));
	fs.writeFileSync(path.join(dir, 'codegen.config.yaml'), config);
	return dir;
}

describe('subsystem install identity', () => {
	it('is allowed under pattern-stack', () => {
		expect(patternStackSubsystemRefusal('identity', 'drizzle')).toBeNull();
	});

	it('vendors the runtime and its closure, the three YAMLs, the identity: block, the tenant column and the principal source', async () => {
		const cwd = project();
		const ctx = contextOf(cwd);
		const result = await installIdentity(ctx, { force: false, dryRun: false, configPath: path.join(cwd, 'codegen.config.yaml') });
		for (const f of ['src/shared/subsystems/identity/core.ts', 'src/shared/requester.ts', 'src/shared/subsystems/events/pg-notify.ts']) {
			expect(fs.existsSync(path.join(cwd, f))).toBe(true);
		}
		for (const f of ['user.yaml', 'workspace.yaml', 'membership.yaml']) expect(fs.existsSync(path.join(cwd, 'entities/identity', f))).toBe(true);
		const config = fs.readFileSync(path.join(cwd, 'codegen.config.yaml'), 'utf8');
		expect(config).toContain('identity:\n');
		expect(config).toContain('  workspace_from: header\n');
		expect(config).toContain('    cache: postgres\n');
		expect(config).toContain('tenancy:\n');
		expect(config).toContain('  column: workspace_id\n');
		expect(fs.readFileSync(path.join(cwd, 'src/identity/principal-source.ts'), 'utf8')).toBe(
			principalSourceScaffold('@shared/subsystems/identity/core'),
		);
		expect(result.notes).toEqual([]);
	});

	it('in package mode records identity under subsystems.install and vendors no runtime', async () => {
		const cwd = project(TARGET.replace('runtime: vendored\n', 'runtime: package\n'));
		await installIdentity(contextOf(cwd), { force: false, dryRun: false, configPath: path.join(cwd, 'codegen.config.yaml') });
		expect(fs.readFileSync(path.join(cwd, 'codegen.config.yaml'), 'utf8')).toMatch(/subsystems:\n  install:\n    - identity\n/);
		expect(fs.existsSync(path.join(cwd, 'src/shared/subsystems/identity'))).toBe(false);
		expect(fs.readFileSync(path.join(cwd, 'src/identity/principal-source.ts'), 'utf8')).toContain(
			"from '@pattern-stack/codegen/runtime/subsystems/identity/core'",
		);
	});

	it('re-running adds no second block, and --force never replaces the principal source', async () => {
		const cwd = project();
		const configPath = path.join(cwd, 'codegen.config.yaml');
		const ctx = contextOf(cwd);
		await installIdentity(ctx, { force: false, dryRun: false, configPath });
		const principal = path.join(cwd, 'src/identity/principal-source.ts');
		fs.writeFileSync(principal, '// mine');
		await installIdentity(ctx, { force: true, dryRun: false, configPath });
		expect(fs.readFileSync(principal, 'utf8')).toBe('// mine');
		expect(fs.readFileSync(configPath, 'utf8').match(/^identity:/gm)).toHaveLength(1);
		expect(fs.readFileSync(configPath, 'utf8').match(/^tenancy:/gm)).toHaveLength(1);
	});

	it('leaves the tenant column alone when tenant_scoped entities already use the default one', async () => {
		const cwd = project();
		fs.mkdirSync(path.join(cwd, 'entities'));
		fs.writeFileSync(path.join(cwd, 'entities/invoice.yaml'), 'entity:\n  name: invoice\n  plural: invoices\ntenant_scoped: true\n');
		const result = await installIdentity(contextOf(cwd), { force: false, dryRun: false, configPath: path.join(cwd, 'codegen.config.yaml') });
		expect(fs.readFileSync(path.join(cwd, 'codegen.config.yaml'), 'utf8')).not.toContain('tenancy:');
		expect(result.notes.join()).toContain("tenancy.column is 'tenant_id'");
	});

	it("keeps a project's own tenancy column, and says the workspace points through it", async () => {
		const cwd = project(`${TARGET}tenancy:\n  column: org_id\n`);
		const ctx = contextOf(cwd);
		const result = await installIdentity(ctx, { force: false, dryRun: false, configPath: path.join(cwd, 'codegen.config.yaml') });
		expect(result.notes.join()).toContain("tenancy.column is 'org_id'");
		expect(fs.readFileSync(path.join(cwd, 'codegen.config.yaml'), 'utf8')).not.toContain('workspace_id');
	});
});

/** The pattern-stack smoke's fixtures plus identity's three YAMLs (optionally changed), in a temp entities dir. */
function entities(mutate: (name: string, yaml: string) => string = (_n, y) => y, without: string[] = []): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-ps-'));
	const fixtures = path.join(REPO, 'test/smoke/fixtures-pattern-stack');
	for (const f of fs.readdirSync(fixtures)) fs.copyFileSync(path.join(fixtures, f), path.join(dir, f));
	fs.mkdirSync(path.join(dir, 'identity'));
	for (const f of ['user', 'workspace', 'membership'].filter((n) => !without.includes(n))) {
		const yaml = fs.readFileSync(path.join(REPO, 'examples/identity/definitions/entities/identity', `${f}.yaml`), 'utf8');
		fs.writeFileSync(path.join(dir, 'identity', `${f}.yaml`), mutate(f, yaml));
	}
	return dir;
}

function compose(entitiesDir: string, principalSourceFile = path.join(REPO, 'test/smoke/fixtures-pattern-stack-usage/principal-source.ts')) {
	const identity: CompositionIdentityInput = {
		coreImport: '@shared/subsystems/identity/core',
		workspaceFrom: 'path',
		resolver: 'lookup',
		cache: 'memory',
		principalSourceFile,
		roles: ROLES,
	};
	const files = planComposition({
		relations: loadProjectApiContext(ROOT, null, {
			entitiesDir,
			junctionsDir: '/nonexistent/junctions',
			relationshipsDir: '/nonexistent/relationships',
		}).relations,
		modulesDir: `${ROOT}/modules`,
		generatedDir: `${ROOT}/generated`,
		drizzleTypeImport: '@shared/types/drizzle',
		openApiImport: '@shared/openapi',
		banner: '// @generated',
		events: {
			backend: 'drizzle',
			multiTenant: false,
			listenNotify: false,
			backendImport: '@shared/subsystems/events/event-bus.drizzle-backend',
			coreImport: '@shared/subsystems/events/core',
			generatedEventsDir: `${ROOT}/shared/subsystems/events/generated`,
		},
		identity,
		dryRun: true,
	});
	return (suffix: string) => files.find((f) => f.path.endsWith(suffix))?.content ?? null;
}

describe('the requester system and the workspaces module', () => {
	const file = compose(entities());

	it('requester: each port is its registry row for the config value; it builds its own membership repository', () => {
		const r = file('/generated/requester-system.ts')!;
		expect(r).toContain("REQUESTER_CACHES['memory']({");
		expect(r).toContain("WORKSPACE_SOURCES['path']()");
		expect(r).toContain("REQUESTER_RESOLVERS['lookup']({ principals: principalSource, workspaces, cache })");
		expect(r).toContain("import { createMembershipRepository } from '../modules/identity/memberships/membership.wiring';");
		expect(r).toMatch(/name: 'requester',\n  uses: \['database'\],/);
		expect(r).toContain('start: ({ cache }) => cache.start(),');
		// The selection is a lookup, never a branch on the value.
		expect(r).not.toMatch(/switch|if \(| \? [^:]+ : /);
	});

	it("workspaces: WorkspaceService over the identity module's repositories and the requester cache", () => {
		const w = file('/generated/workspaces-module.ts')!;
		expect(w).toContain("dependsOn: ['identity'],\n  uses: ['database', 'requester'],");
		expect(w).toContain('memberships: deps.identity.repositories.membership,');
		expect(w).toContain('cache: deps.requester.cache,');
		expect(w).toContain("import { memberships } from '../modules/identity/memberships/membership.entity';");
		expect(w).toContain(".where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'owner')))\n            .for('update')");
		expect(w).toContain(".where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))\n            .for('update')");
		expect(w).toContain('workspaceSource: deps.requester.workspaces,');
		expect(w).not.toContain('as DrizzleClient');
	});

	it("identity's entities have no generated commands: no entry in the commands table (generate.commands: false)", () => {
		const commands = file('/generated/commands.ts')!;
		expect(commands).not.toMatch(/\b(userCommands|workspaceCommands|membershipCommands)\b/);
		expect(commands).toContain('accountCommands');
	});

	it('both are registered: SystemApis, ModuleApis, SYSTEMS, MODULES', () => {
		expect(file('/generated/wiring.ts')).toContain('  requester: RequesterApi;\n');
		expect(file('/generated/wiring.ts')).toContain('  workspaces: WorkspacesModule;\n');
		expect(file('/generated/composition.ts')).toMatch(/SYSTEMS = \[[^\]]*requesterSystem/);
		expect(file('/generated/composition.ts')).toMatch(/MODULES = \[[^\]]*workspacesModule\] as const/);
	});

	it('refuses: a missing entity, one outside the identity context, other role choices, no principal source', () => {
		expect(() => compose(entities(undefined, ['membership']))).toThrow(/no 'membership' entity/);
		expect(() => compose(entities((n, y) => (n === 'user' ? y.replace('context: identity', 'context: people') : y)))).toThrow(
			/must be in the 'identity' context/,
		);
		expect(() =>
			compose(entities((n, y) => (n === 'membership' ? y.replace('[owner, admin, member]', '[owner, guest]') : y))),
		).toThrow(/role choices \(owner, guest\) must be identity's roles/);
		expect(() => compose(entities(), '/nonexistent/principal-source.ts')).toThrow(/re-run `codegen subsystem install identity`/);
	});
});
