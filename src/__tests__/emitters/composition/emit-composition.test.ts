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
const ROOT = '/app/src';

function relationsOf(entitiesDir: string) {
	return loadProjectApiContext(ROOT, null, {
		entitiesDir,
		junctionsDir: '/nonexistent/junctions',
		relationshipsDir: '/nonexistent/relationships',
	}).relations;
}

function plan(entitiesDir = FIXTURES) {
	const files = planComposition({
		relations: relationsOf(entitiesDir),
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
			'  registerInvoiceSchemas(openApi);',
			'  registerNoteSchemas(openApi);',
			'  registerPartySchemas(openApi);',
			'  registerPersonSchemas(openApi);',
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
		expect(() => plan(dir)).toThrow(/entity 'repositories' would be the key 'repositories' in module 'entities'/);
	});

	it('names every entity whose .wiring.ts is missing or lacks what the composition imports', () => {
		const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw3b-modules-'));
		const relations = relationsOf(FIXTURES);
		expect(wiringFilesBehind({ relations, modulesDir })).toEqual(['account', 'contact', 'invoice', 'note', 'party', 'person']);
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
