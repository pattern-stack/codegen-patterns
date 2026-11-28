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

function plan(entitiesDir = FIXTURES, junctionsDir = JUNCTIONS) {
	const files = planComposition({
		relations: relationsOf(entitiesDir, junctionsDir),
		modulesDir: `${ROOT}/modules`,
		generatedDir: `${ROOT}/generated`,
		drizzleTypeImport: '@shared/types/drizzle',
		openApiImport: '@shared/openapi',
		banner: '// @generated',
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
