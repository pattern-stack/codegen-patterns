/**
 * The pattern-stack wiring composition's text (PW-3a, PW-3b), over the pattern-stack smoke's fixtures. `test-smoke-pattern-stack` compiles
 * and runs it; this pins what each file declares, so a change shows up here first.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadProjectApiContext } from '../../../derived/api/project';
import { planComposition, wiringFilesBehind } from '../../../emitters/composition/emit-composition';

const FIXTURES = path.resolve(import.meta.dir, '../../../../test/smoke/fixtures-pattern-stack');
const JUNCTIONS = path.resolve(import.meta.dir, '../../../../test/smoke/fixtures-pattern-stack-junctions');
const ROOT = '/app/src';

function relationsOf(entitiesDir: string, junctionsDir = JUNCTIONS) {
	return loadProjectApiContext(ROOT, null, {
		entitiesDir,
		junctionsDir,
		relationshipsDir: '/nonexistent/relationships',
	}).relations;
}

/** The smoke's events install (S-1): drizzle, vendored. */
const EVENTS = {
	backend: 'drizzle' as const,
	multiTenant: false,
	listenNotify: false,
	backendImport: '@shared/subsystems/events/event-bus.drizzle-backend',
	coreImport: '@shared/subsystems/events/core',
	generatedEventsDir: `${ROOT}/shared/subsystems/events/generated`,
};

type IntegrationInput = NonNullable<Parameters<typeof planComposition>[0]['integration']>;
const INTEGRATION: IntegrationInput = {
	backend: 'drizzle',
	multiTenant: false,
	coreImport: '@shared/subsystems/integration/core',
	runtimeImport: (relpath: string) => `@shared/${relpath}`,
};

type IntegrationsInput = NonNullable<Parameters<typeof planComposition>[0]['integrations']>;
const INTEGRATIONS: IntegrationsInput = {
	moduleFile: `${ROOT}/integrations/module.ts`,
	coreImport: '@shared/subsystems/integration/core',
	systems: [
		{ name: 'acmeProvider', exportName: 'acmeProviderSystem', file: `${ROOT}/integrations/providers/acme/acme.provider.ts`, apiType: 'AcmeProvider' },
		{ name: 'crmAdapters', exportName: 'crmAdaptersSystem', file: `${ROOT}/integrations/crm/crm-adapters.system.ts`, apiType: 'CrmAdaptersApi' },
	],
	runs: [
		{
			surface: 'crm',
			entity: 'account',
			provider: 'acme',
			adaptersSystem: 'crmAdapters',
			adapterKey: 'acme',
			sinkFile: `${ROOT}/integrations/crm/sinks/account.sink.ts`,
			sinkClass: 'AccountSink',
			repositoryFile: `${ROOT}/modules/crm/accounts/account.repository.ts`,
			projectionType: 'AccountIntegrationProjection',
		},
	],
};

function plan(
	entitiesDir = FIXTURES,
	junctionsDir = JUNCTIONS,
	events: typeof EVENTS | null = EVENTS,
	integration: IntegrationInput | null = null,
	integrations: IntegrationsInput | null = null,
) {
	const files = planComposition({
		relations: relationsOf(entitiesDir, junctionsDir),
		modulesDir: `${ROOT}/modules`,
		generatedDir: `${ROOT}/generated`,
		drizzleTypeImport: '@shared/types/drizzle',
		openApiImport: '@shared/openapi',
		banner: '// @generated',
		events,
		integration,
		integrations,
		dryRun: true,
	});
	return (suffix: string) => {
		const f = files.find((x) => x.path.endsWith(suffix));
		if (!f) throw new Error(`no file ending ${suffix}: ${files.map((x) => x.path).join(', ')}`);
		return f.content;
	};
}

describe('the composition (PW-3b)', () => {
	const file = plan();

	it("declares each context's repository bundle, one port per entity, and checks the composed repositories against it", () => {
		const crm = file('/modules/crm/module.ts');
		expect(crm).toContain('export interface CrmRepositories {');
		for (const line of [
			'  account: AccountRepositoryPort;',
			'  contact: ContactRepositoryPort;',
			'  party: PartyRepositoryPort;',
			'  person: PersonRepositoryPort;',
			'  tag: TagRepositoryPort;',
		]) {
			expect(crm).toContain(line);
		}
		expect(crm).toMatch(/repositories: \{ [^}]+ \} satisfies CrmRepositories,/);
		expect(crm).toContain('type AccountRepositoryPort }');
		expect(file('/modules/module.ts')).toContain('export interface EntitiesRepositories {\n  note: NoteRepositoryPort;\n}');
	});

	it("writes openapi.ts, which registers every entity's schemas", () => {
		const openapi = file('/generated/openapi.ts');
		expect(openapi).toContain("import type { OpenApiRegistry } from '@shared/openapi';");
		expect(openapi).toContain("import { registerAccountSchemas } from '../modules/crm/accounts/account.wiring';");
		expect(openapi).toContain("import { registerNoteSchemas } from '../modules/notes/note.wiring';");
		const calls = openapi.match(/^ {2}register\w+Schemas\(openApi\);$/gm);
		expect(calls).toEqual([
			'  registerAccountSchemas(openApi);',
			'  registerContactSchemas(openApi);',
			'  registerFieldDefinitionSchemas(openApi);',
			'  registerFieldValueSchemas(openApi);',
			'  registerInvoiceSchemas(openApi);',
			'  registerLeadSchemas(openApi);',
			'  registerNoteSchemas(openApi);',
			'  registerPartySchemas(openApi);',
			'  registerPersonSchemas(openApi);',
			'  registerTagSchemas(openApi);',
		]);
	});
});

describe('the composition refuses and warns (PW-3b)', () => {
	it("refuses an entity whose key would replace the module's 'repositories' bundle", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw3b-'));
		fs.writeFileSync(
			path.join(dir, 'repositories.yaml'),
			'entity:\n  name: repositories\n  plural: repository_sets\nfields:\n  label:\n    type: string\n',
		);
		expect(() => plan(dir, '/nonexistent/junctions')).toThrow(/entity 'repositories' would be the key 'repositories' in module 'entities'/);
	});

	it("refuses an entity whose register function would be openapi.ts's own registerOpenApiSchemas", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw3b-'));
		fs.writeFileSync(
			path.join(dir, 'open_api.yaml'),
			'entity:\n  name: open_api\n  plural: open_apis\nfields:\n  label:\n    type: string\n',
		);
		expect(() => plan(dir, '/nonexistent/junctions')).toThrow(/entity 'open_api' would export 'registerOpenApiSchemas'/);
	});

	it('names every entity whose .wiring.ts is missing or lacks what the composition imports', () => {
		const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw3b-modules-'));
		const relations = relationsOf(FIXTURES);
		expect(wiringFilesBehind({ relations, modulesDir })).toEqual([
			'account',
			'account_tag',
			'contact',
			'field_definition',
			'field_value',
			'invoice',
			'lead',
			'note',
			'party',
			'person',
			'tag',
		]);
		// A PW-3a-era file: the factories, but no port and no schema registration.
		fs.mkdirSync(path.join(modulesDir, 'notes'), { recursive: true });
		const pw3a = 'export function createNoteRepository() {}\nexport function createNoteServices() {}\n';
		fs.writeFileSync(path.join(modulesDir, 'notes', 'note.wiring.ts'), pw3a);
		expect(wiringFilesBehind({ relations, modulesDir })).toContain('note');
		fs.writeFileSync(
			path.join(modulesDir, 'notes', 'note.wiring.ts'),
			`${pw3a}export type NoteRepositoryPort = {};\nexport function registerNoteSchemas() {}\n`,
		);
		// H-1: the commands table imports its commands too, so a file without them is behind.
		expect(wiringFilesBehind({ relations, modulesDir })).toContain('note');
		fs.writeFileSync(path.join(modulesDir, 'notes', 'note.commands.ts'), 'export const noteCommands = [];\n');
		expect(wiringFilesBehind({ relations, modulesDir })).not.toContain('note');
	});
});

describe('junctions in the composition (PW-3c)', () => {
	it("builds a junction in its ends' module: its repository, then its service, then the parents' services take it", () => {
		const crm = plan()('/modules/crm/module.ts');
		expect(crm).toContain("import { createAccountTagRepository, createAccountTagService } from '../account-tags/account-tag.wiring';");
		const lines = crm.split('\n');
		const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
		expect(at('const accountTagRepository = createAccountTagRepository(db);')).toBeGreaterThan(at('const tagRepository ='));
		expect(at('const accountTagService = createAccountTagService({ repository: accountTagRepository, left: accountRepository, right: tagRepository });')).toBeGreaterThan(
			at('const accountTagRepository ='),
		);
		expect(at('accountTagService: accountTagService })')).toBeGreaterThan(at('const accountTagService ='));
		expect(crm).toContain('    junctions: { accountTag: accountTagService },');
	});

	it('refuses a junction across two modules, naming the cycle and the junction', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw3c-'));
		fs.writeFileSync(path.join(dir, 'account_invoice.yaml'), 'pattern: Junction\nbetween: [account, invoice]\n');
		expect(() =>
			planComposition({
				relations: relationsOf(FIXTURES, dir),
				modulesDir: `${ROOT}/modules`,
				generatedDir: `${ROOT}/generated`,
				drizzleTypeImport: '@shared/types/drizzle',
				openApiImport: '@shared/openapi',
				banner: '// @generated',
				dryRun: true,
			}),
		).toThrow(/cycle: (billing → crm → billing|crm → billing → crm).*account_invoice/);
	});
});

describe("a junction's module (PW-3c)", () => {
	const withJunction = (yaml: string) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw3c-one-sided-'));
		fs.writeFileSync(path.join(dir, 'account_invoice.yaml'), yaml);
		return planComposition({
			relations: relationsOf(FIXTURES, dir),
			modulesDir: `${ROOT}/modules`,
			generatedDir: `${ROOT}/generated`,
			drizzleTypeImport: '@shared/types/drizzle',
			openApiImport: '@shared/openapi',
			banner: '// @generated',
			events: EVENTS,
			dryRun: true,
		});
	};

	it('is the module of the only parent that fans out to it, even across modules', () => {
		const files = withJunction(
			'pattern: Junction\nbetween: [account, invoice]\nexpose_on_parent:\n  left: false\n  right: true\n',
		);
		const billing = files.find((f) => f.path.endsWith('/billing/module.ts'))!.content;
		expect(billing).toContain('const accountInvoiceService = createAccountInvoiceService({ repository: accountInvoiceRepository, left: deps.crm.repositories.account, right: invoiceRepository });');
		expect(billing).toContain("dependsOn: ['crm']");
		expect(files.find((f) => f.path.endsWith('/crm/module.ts'))!.content).not.toContain('accountInvoice');
	});
});

describe('EAV in the composition', () => {
	it("builds FieldValueService (another module's) before the EAV entity's repository and service, which take it", () => {
		const get = plan();
		const crm = get('/modules/crm/module.ts');
		expect(crm).toContain("dependsOn: ['customFields'],");
		expect(crm).toContain('  const leadRepository = createLeadRepository(db, deps.customFields.fieldValue.service);');
		expect(crm).toContain(
			'  const lead = createLeadServices({ repository: leadRepository, fieldValues: deps.customFields.fieldValue.service, db });',
		);
		// The value table's service takes its definition entity's repository.
		expect(get('/modules/custom-fields/module.ts')).toContain(
			'  const fieldValue = createFieldValueServices({ repository: fieldValueRepository, fieldDefinitionRepo: fieldDefinitionRepository });',
		);
	});

	it('in one module, moves only the EAV repository: after FieldValueService, every other line keeps its phase', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eav-one-module-'));
		for (const f of ['lead.yaml', 'field_value.yaml', 'field_definition.yaml', 'tag.yaml']) {
			fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(FIXTURES, f), 'utf8').replace(/^ {2}context: .*\n/m, ''));
		}
		const root = plan(dir, '/nonexistent/junctions')('/modules/module.ts');
		const built = root.split('\n').filter((l) => /^ {2}const \w+ = create/.test(l)).map((l) => l.match(/const (\w+)/)![1]);
		expect(built).toEqual([
			'fieldDefinitionRepository',
			'fieldValueRepository',
			'tagRepository',
			'fieldDefinition',
			'fieldValue',
			'leadRepository',
			'lead',
			'tag',
		]);
		expect(root).toContain('createLeadRepository(db, fieldValue.service)');
	});
});

describe('the events system in the composition (S-1)', () => {
	it('writes events-system.ts, lists it in SYSTEMS and SystemApis, and the publishing module uses it', () => {
		const get = plan();
		const system = get('/generated/events-system.ts');
		expect(system).toContain("import { DrizzleEventBus } from '@shared/subsystems/events/event-bus.drizzle-backend';");
		expect(system).toContain("import { TypedEventBus, eventRegistry } from '../shared/subsystems/events/generated';");
		expect(system).toContain("uses: ['database'],");
		expect(system).toContain('const bus = new DrizzleEventBus(database.db, options);');
		expect(system).toMatch(/start: async \(\{ bus, scheduler \}\) => \{\n {4}await bus\.start\(\);\n {4}try \{\n {6}await scheduler\?\.start\(\);/);
		// A scheduler that fails to start stops the drain loop the start began (compose won't stop a failed part).
		expect(system).toMatch(/catch \(err\) \{\n[^\n]*\n {6}await bus\.stop\(\);\n {6}throw err;/);
		expect(get('/generated/composition.ts')).toContain('export const SYSTEMS = [eventsSystem] as const;');
		expect(get('/generated/wiring.ts')).toContain('  events: EventsApi;');
		const billing = get('/modules/billing/module.ts');
		expect(billing).toContain("uses: ['database', 'events'],");
		expect(billing).toContain('events: EventsApi');
		expect(billing).toContain('typedEvents: deps.events.typed');
		// A module with no publishing use case doesn't use it.
		expect(get('/modules/crm/module.ts')).toContain("uses: ['database'],");
	});

	it('refuses a publishing entity when the events subsystem is not installed, naming the install', () => {
		expect(() => plan(FIXTURES, JUNCTIONS, null)).toThrow(/invoice publish events .* run `codegen subsystem install events`/);
	});

	it('the memory backend uses no database', () => {
		const system = plan(FIXTURES, JUNCTIONS, {
			...EVENTS,
			backend: 'memory' as unknown as 'drizzle',
			backendImport: '@shared/subsystems/events/event-bus.memory-backend',
		})('/generated/events-system.ts');
		expect(system).toContain('uses: [],');
		expect(system).toContain('const bus = new MemoryEventBus(options);');
	});
});

describe('the integration system in the composition (S-3)', () => {
	it('writes integration-system.ts on the drizzle backends and lists it in SYSTEMS and SystemApis', () => {
		const get = plan(FIXTURES, JUNCTIONS, EVENTS, INTEGRATION);
		const system = get('/generated/integration-system.ts');
		expect(system).toContain(
			"import { DeepEqualDiffer, type IntegrationSubstrate } from '@shared/subsystems/integration/core';",
		);
		expect(system).toContain("import { PostgresCursorStore } from '@shared/subsystems/integration/integration-cursor-store.drizzle-backend';");
		expect(system).toContain("uses: ['database'],");
		expect(system).toContain('cursors: new PostgresCursorStore(database.db, false),');
		expect(system).toContain('recorder: new DrizzleIntegrationRunRecorder(database.db, false),');
		expect(system).toContain('differ: new DeepEqualDiffer<object>(),');
		expect(get('/generated/composition.ts')).toContain('export const SYSTEMS = [eventsSystem, integrationSystem] as const;');
		expect(get('/generated/wiring.ts')).toContain('  integration: IntegrationApi;');
	});

	it('the memory backend uses no database; the config\'s multi-tenant flag and differ options reach the parts', () => {
		const system = plan(FIXTURES, JUNCTIONS, EVENTS, {
			...INTEGRATION,
			backend: 'memory',
			multiTenant: true,
			differ: { unignore: ['deletedAt'] },
		})('/generated/integration-system.ts');
		expect(system).toContain('uses: [],');
		expect(system).toContain('cursors: new MemoryCursorStore(),');
		expect(system).toContain('recorder: new MemoryRunRecorder(),');
		expect(system).toContain('differ: new DeepEqualDiffer<object>({"unignore":["deletedAt"]}),');
		expect(system).toContain('multiTenant: true,');
		expect(system).not.toContain('drizzle-backend');
	});

	it('writes no integration system when the subsystem is not installed', () => {
		const get = plan();
		expect(() => get('/generated/integration-system.ts')).toThrow(/no file ending/);
		expect(get('/generated/composition.ts')).toContain('export const SYSTEMS = [eventsSystem] as const;');
	});
});

describe('the integrations in the composition (S-3)', () => {
	it("lists the providers' and surfaces' systems, and writes the integrations module over the entity's module", () => {
		const get = plan(FIXTURES, JUNCTIONS, EVENTS, INTEGRATION, INTEGRATIONS);
		expect(get('/generated/composition.ts')).toContain(
			'export const SYSTEMS = [eventsSystem, integrationSystem, acmeProviderSystem, crmAdaptersSystem] as const;',
		);
		expect(get('/generated/composition.ts')).toMatch(/export const MODULES = \[.*integrationsModule\] as const;/);
		const wiring = get('/generated/wiring.ts');
		expect(wiring).toContain("import type { CrmAdaptersApi } from '../integrations/crm/crm-adapters.system';");
		expect(wiring).toContain('  crmAdapters: CrmAdaptersApi;');
		expect(wiring).toContain('  integrations: IntegrationsModule;');
		const module = get('/integrations/module.ts');
		expect(module).toContain("dependsOn: ['crm'],");
		expect(module).toContain("uses: ['integration', 'crmAdapters'],");
		expect(module).toContain(
			'        acme: new IntegrationRunner<AccountIntegrationProjection>({\n' +
				'          ...deps.integration,\n' +
				'          source: deps.crmAdapters.adapters.acme.changeSources.account as IChangeSource<AccountIntegrationProjection>,\n' +
				"          sink: new AccountSink(deps.crm.repositories.account, 'acme'),\n" +
				'        }),',
		);
		expect(module).toContain("import type { AccountIntegrationProjection } from '../modules/crm/accounts/account.repository';");
	});

	it('an emit_changes run takes its change emitter over the events system, which it then uses', () => {
		const emitting = {
			...INTEGRATIONS,
			runs: INTEGRATIONS.runs.map((r) => ({ ...r, emitter: { file: `${ROOT}/integrations/crm/sinks/account.change-emitter.ts`, className: 'AccountChangeEmitter' } })),
		};
		const module = plan(FIXTURES, JUNCTIONS, EVENTS, INTEGRATION, emitting)('/integrations/module.ts');
		expect(module).toContain("uses: ['integration', 'crmAdapters', 'events'],");
		expect(module).toContain('          emitter: new AccountChangeEmitter(deps.events.typed),');
		expect(() => plan(FIXTURES, JUNCTIONS, null, INTEGRATION, emitting)).toThrow(/run `codegen subsystem install events`/);
	});

	it('refuses runs without the integration subsystem, and a system named like a module', () => {
		expect(() => plan(FIXTURES, JUNCTIONS, EVENTS, null, INTEGRATIONS)).toThrow(/run `codegen subsystem install integration`/);
		const clash = { ...INTEGRATIONS, systems: [...INTEGRATIONS.systems, { ...INTEGRATIONS.systems[0]!, name: 'crm' }] };
		expect(() => plan(FIXTURES, JUNCTIONS, EVENTS, INTEGRATION, clash)).toThrow(/integration system 'crm' would share its name/);
	});

	it('with no run, the systems are composed and there is no integrations module', () => {
		const get = plan(FIXTURES, JUNCTIONS, EVENTS, null, { ...INTEGRATIONS, runs: [] });
		expect(get('/generated/composition.ts')).toContain('acmeProviderSystem, crmAdaptersSystem] as const;');
		expect(() => get('/integrations/module.ts')).toThrow(/no file ending/);
		expect(get('/generated/wiring.ts')).not.toContain('IntegrationsModule');
	});
});
