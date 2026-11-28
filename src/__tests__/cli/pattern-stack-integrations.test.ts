/**
 * Integrations under `wiring: pattern-stack` (S-3): the plan (which systems and runs), the provider's factory and
 * system, the adapters system, and the Nest generators' pattern-stack text (adapter scaffold, sink, change emitter).
 * The emitted tree is the integration-emit golden; the `integrations` module is the composition's.
 */
import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import {
	generateAdaptersSystem,
	generateProviderFactory,
	generateProviderSystem,
	planPatternStackIntegrations,
} from '../../cli/shared/pattern-stack-integrations';
import { generateAdapterScaffold } from '../../cli/shared/adapter-emission-generator';
import { generateChangeEmitter } from '../../cli/shared/change-emitter-emission-generator';
import { findYamlFiles } from '../../utils/find-yaml-files';
import { loadEntitiesFromYaml, loadProvidersFromYaml } from '../../utils/yaml-loader';
import type { ActiveProviderDefinition } from '../../schema/provider-definition.schema';
import { providerSettings } from '../../derived/settings';

const FIXTURE = path.resolve(import.meta.dir, '../../../test/fixtures/integration-patterns/definitions');
const providers = loadProvidersFromYaml(findYamlFiles(path.join(FIXTURE, 'providers'))).successes.map((p) => ({
	definition: p.definition,
	filePath: p.filePath,
}));
const entities = loadEntitiesFromYaml(findYamlFiles(path.join(FIXTURE, 'entities'))).successes.map((e) => e.definition);
const def = (slug: string) => providers.find((p) => p.definition.slug === slug)!.definition as ActiveProviderDefinition;
const NEST = /@nestjs\/|@Inject|@Injectable/;
const ROOT = '/app/src';

const plan = planPatternStackIntegrations({
	providers,
	entities,
	outputRoot: `${ROOT}/integrations`,
	backendSrcAbs: ROOT,
	modulesAbs: `${ROOT}/modules`,
	mode: 'package',
});

describe('the plan', () => {
	it('a system per provider, then one per surface with a package', () => {
		expect(plan.systems.map((s) => s.name)).toEqual([
			'googleProvider',
			'salesforceProvider',
			'calendarAdapters',
			'crmAdapters',
			'mailAdapters',
			'transcriptAdapters',
		]);
		expect(plan.systems.find((s) => s.name === 'crmAdapters')).toMatchObject({
			exportName: 'crmAdaptersSystem',
			apiType: 'CrmAdaptersApi',
			file: `${ROOT}/integrations/crm/crm-adapters.system.ts`,
		});
	});

	it('a run per (surface, Integrated entity, provider), reading the entity repository and its sink', () => {
		expect(plan.runs.map((r) => `${r.surface}.${r.entity}.${r.provider}`)).toEqual([
			'calendar.meeting.google',
			'crm.account.salesforce',
			'crm.contact.salesforce',
			'crm.lead.salesforce',
			'crm.message.salesforce',
			'crm.opportunity.salesforce',
			'mail.email.google',
			'transcript.transcript.google',
		]);
		const contact = plan.runs.find((r) => r.entity === 'contact')!;
		expect(contact).toMatchObject({
			adaptersSystem: 'crmAdapters',
			adapterKey: 'salesforce',
			sinkFile: `${ROOT}/integrations/crm/sinks/contact.sink.ts`,
			sinkClass: 'ContactSink',
			repositoryFile: `${ROOT}/modules/contacts/contact.repository.ts`,
			projectionType: 'ContactIntegrationProjection',
		});
		expect(contact.emitter).toBeUndefined();
		// message declares integration.sink.emit_changes: its runs take its change emitter.
		expect(plan.runs.find((r) => r.entity === 'message')!.emitter).toEqual({
			file: `${ROOT}/integrations/crm/sinks/message.change-emitter.ts`,
			className: 'MessageChangeEmitter',
		});
		expect(plan.moduleFile).toBe(`${ROOT}/integrations/module.ts`);
	});

	it('a surface entity that is not Integrated gets no run, with the reason', () => {
		const contact = entities.find((e) => e.entity.name === 'contact')!;
		const notIntegrated = { ...contact, entity: { ...contact.entity, pattern: undefined, patterns: undefined } };
		const p = planPatternStackIntegrations({
			providers,
			entities: [notIntegrated],
			outputRoot: `${ROOT}/integrations`,
			backendSrcAbs: ROOT,
			modulesAbs: `${ROOT}/modules`,
			mode: 'package',
		});
		expect(p.runs).toEqual([]);
		expect(p.skippedAssemblies[0]!.reason).toMatch(/not 'pattern: Integrated'/);
	});
});

describe('the provider', () => {
	const FACTORY = `${ROOT}/integrations/providers/salesforce/salesforce.provider.factory.ts`;
	const SETTINGS_FILE = `${ROOT}/generated/settings.ts`;
	const sfWith = (settings: Record<string, { secret?: boolean }>) => {
		const d = { ...def('salesforce'), settings } as ActiveProviderDefinition;
		return { d, own: providerSettings({ definition: d, filePath: '' }) };
	};

	it("the factory (author-owned) takes the provider's typed settings and shows the calls with its keys", () => {
		const { d, own } = sfWith({ client_id: { secret: true }, client_secret: { secret: true } });
		const factory = generateProviderFactory(d, own, FACTORY, SETTINGS_FILE);
		expect(factory).toStartWith('// <CODEGEN-SCAFFOLD-V1>');
		expect(factory).toContain("import type { Settings } from '../../../generated/settings';");
		expect(factory).toContain("export function createSalesforceProvider(settings: Settings['salesforce']): SalesforceProvider {");
		expect(factory).toContain('new SalesforceOAuthStrategy({ clientId: settings.clientId, clientSecret: settings.clientSecret })');
		expect(factory).toContain('new SalesforceClient({ baseUrl: settings.baseUrl })');
		// Not prefilled: the constructors are the author's, so a no-argument class still compiles.
		expect(factory).toContain('auth: new SalesforceOAuthStrategy(),\n    client: new SalesforceClient(),');
		expect(factory).toContain('export interface SalesforceProvider {\n  auth: SalesforceOAuthStrategy;\n  client: SalesforceClient;\n}');
	});

	it('a per-connection provider (every surface a read primitive) has no client', () => {
		const g = def('google');
		const factory = generateProviderFactory(g, providerSettings({ definition: g, filePath: '' }), FACTORY, SETTINGS_FILE);
		expect(factory).toContain('export interface GoogleProvider {\n  auth: GoogleOAuthStrategy;\n}');
		expect(factory).not.toContain('GoogleClient');
	});

	it('the system gives the factory its settings', () => {
		const system = generateProviderSystem(def('salesforce'), `${ROOT}/integrations/providers/salesforce/salesforce.provider.ts`, `${ROOT}/generated/wiring.ts`);
		expect(system).toContain("import { defineSystem } from '../../../generated/wiring';");
		expect(system).toContain(
			"name: 'salesforceProvider',\n  uses: ['settings'],\n  create: ({ settings }): SalesforceProvider => createSalesforceProvider(settings.salesforce),",
		);
		expect(system).not.toMatch(NEST);
	});
});

describe('the adapters', () => {
	it("the adapters system builds each provider's adapter from its system, and folds the sources on demand", () => {
		const file = `${ROOT}/integrations/crm/crm-adapters.system.ts`;
		const defs = new Map([['salesforce', def('salesforce')]]);
		const system = generateAdaptersSystem('crm', ['salesforce'], defs, file, `${ROOT}/generated/wiring.ts`, '@x/integration/core', `${ROOT}/integrations`);
		expect(system).toContain("uses: ['salesforceProvider'],");
		expect(system).toContain('salesforce: new SalesforceCrmAdapter(salesforceProvider.auth, salesforceProvider.client),');
		expect(system).toContain('sources: () =>\n        foldCrmEntitySources([');
		expect(system).toContain("ambiguous change source");
		expect(system).toContain('const merged = new globalThis.Map<');
		expect(system).not.toMatch(NEST);
		// A per-connection provider's adapter takes its auth only.
		const cal = generateAdaptersSystem('calendar', ['google'], new Map([['google', def('google')]]), file, `${ROOT}/generated/wiring.ts`, '@x', `${ROOT}/integrations`);
		expect(cal).toContain('google: new GoogleCalendarAdapter(googleProvider.auth),');
	});

	it("the scaffold is a plain class typed by the provider's factory; the Nest one is unchanged", () => {
		const ps = generateAdapterScaffold(def('salesforce'), 'crm', ['contact'], undefined, 'package', 'pattern-stack');
		expect(ps).not.toMatch(NEST);
		expect(ps).toContain("import type { SalesforceProvider } from '../../../providers/salesforce/salesforce.provider.factory';");
		expect(ps).toContain("readonly auth: SalesforceProvider['auth'],\n    private readonly client: SalesforceProvider['client'],");
		expect(ps).toContain("from '@pattern-stack/codegen/runtime/subsystems/integration/core'");
		expect(generateAdapterScaffold(def('salesforce'), 'crm', ['contact'], undefined, 'package')).toBe(
			generateAdapterScaffold(def('salesforce'), 'crm', ['contact'], undefined, 'package', 'nest'),
		);
		const read = generateAdapterScaffold(def('google'), 'calendar', ['meeting'], undefined, 'package', 'pattern-stack');
		expect(read).toContain("constructor(private readonly auth: GoogleProvider['auth']) {");
		expect(read).not.toMatch(NEST);
	});

	it('the change emitter takes the bus as a plain argument', () => {
		const emitter = generateChangeEmitter({
			entityName: 'message',
			entityClass: 'Message',
			surface: 'crm',
			sourceDesc: 'x',
			wiring: 'pattern-stack',
		});
		expect(emitter).not.toMatch(NEST);
		expect(emitter).toContain('constructor(\n    private readonly bus: ChangeEventPublisher,\n  ) {}');
		expect(emitter).toContain("from '@pattern-stack/codegen/runtime/subsystems/integration/core'");
	});
});

/** The adapter's constructor and the system's `new` agree, whatever mix of surfaces a provider serves (review, S-3). */
describe('an adapter takes a client exactly when the system passes one', () => {
	const mixed = { ...def('salesforce'), slug: 'acme', surfaces: ['crm', 'calendar'] } as ActiveProviderDefinition;
	const file = `${ROOT}/integrations/x/x-adapters.system.ts`;
	const wiring = `${ROOT}/generated/wiring.ts`;

	it('a provider with a client: every adapter takes it, a read primitive too, whatever its entities (the scaffold is emit-once)', () => {
		for (const entities of [['meeting'], []]) {
			const scaffold = generateAdapterScaffold(mixed, 'calendar', entities, undefined, 'package', 'pattern-stack');
			expect(scaffold).toMatch(/readonly auth: AcmeProvider\['auth'\],\n {4}(private )?readonly client: AcmeProvider\['client'\],/);
		}
		const system = generateAdaptersSystem('calendar', ['acme'], new Map([['acme', mixed]]), file, wiring, '@x', `${ROOT}/integrations`);
		expect(system).toContain('acme: new AcmeCalendarAdapter(acmeProvider.auth, acmeProvider.client),');
		// Its crm adapter takes the client.
		expect(generateAdapterScaffold(mixed, 'crm', ['contact'], undefined, 'package', 'pattern-stack')).toContain(
			"private readonly client: AcmeProvider['client'],",
		);
		expect(generateAdaptersSystem('crm', ['acme'], new Map([['acme', mixed]]), file, wiring, '@x', `${ROOT}/integrations`)).toContain(
			'acme: new AcmeCrmAdapter(acmeProvider.auth, acmeProvider.client),',
		);
	});

	it('a client-less provider on a read-primitive surface with no entity yet: no client either side', () => {
		const scaffold = generateAdapterScaffold(def('google'), 'calendar', [], undefined, 'package', 'pattern-stack');
		expect(scaffold).not.toContain("['client']");
		expect(scaffold).toContain("  constructor(readonly auth: GoogleProvider['auth']) {}");
		const system = generateAdaptersSystem('calendar', ['google'], new Map([['google', def('google')]]), file, wiring, '@x', `${ROOT}/integrations`);
		expect(system).toContain('google: new GoogleCalendarAdapter(googleProvider.auth),');
	});

	it('a provider with no surface package gets no system (it is a skipped surface)', () => {
		const orphan = { ...providers[0]!, definition: { ...providers[0]!.definition, slug: 'erp_co', surfaces: ['erp'] } };
		const p = planPatternStackIntegrations({
			providers: [...providers, orphan],
			entities,
			outputRoot: `${ROOT}/integrations`,
			backendSrcAbs: ROOT,
			modulesAbs: `${ROOT}/modules`,
			mode: 'package',
		});
		expect(p.systems.map((s) => s.name)).not.toContain('erpCoProvider');
		expect(p.skippedSurfaces).toContainEqual(expect.objectContaining({ provider: 'erp_co', surface: 'erp' }));
	});
});
