/**
 * The shared cross-entity naming module (NAME-0, #630 / #611) —
 * `templates/_shared/entity-naming.mjs`, read by the entity prompt, the
 * backend extension and the junction prompt.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	createEntityLookup,
	entityLookupFrom,
	projectEntityLookup,
	relativeModuleDir,
} from '../../../templates/_shared/entity-naming.mjs';

const tmpDirs: string[] = [];
function tmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-naming-'));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// `entityModuleNaming` is `src/config/module-tree.ts` re-exported (GEN-0, #649):
// its rule is stated in `src/__tests__/config/module-tree.test.ts`.

describe('relativeModuleDir', () => {
	it('flat → flat is the sibling form existing output uses', () => {
		expect(relativeModuleDir('src/modules/accounts', 'src/modules/contacts')).toBe('../contacts');
	});

	it('flat → nested and nested → flat add the context segment', () => {
		expect(relativeModuleDir('src/modules/persons', 'src/modules/org/crews')).toBe('../org/crews');
		expect(relativeModuleDir('src/modules/org/crews', 'src/modules/persons')).toBe('../../persons');
	});

	it('same context stays a sibling', () => {
		expect(relativeModuleDir('src/modules/org/crews', 'src/modules/org/teams')).toBe('../teams');
	});
});

describe('createEntityLookup', () => {
	it("reads another entity's own entity: block from the entities directory, recursively", () => {
		const dir = tmp();
		fs.mkdirSync(path.join(dir, 'people'));
		fs.writeFileSync(
			path.join(dir, 'people', 'person.yaml'),
			'entity:\n  name: person\n  plural: personnel\n  context: hr\n',
		);
		fs.writeFileSync(path.join(dir, 'broken.yaml'), 'entity: [unclosed');
		const lookup = createEntityLookup(dir, { tablePrefix: '' });
		expect(lookup('person')).toEqual({ name: 'person', plural: 'personnel', context: 'hr' });
		expect(lookup('nobody')).toBeNull();
	});

	it('resolves by SQL table name — the table a field-level foreign_key: names (TABLE-0)', () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, 'person.yaml'), 'entity:\n  name: person\n  plural: persons\n');
		const lookup = createEntityLookup(dir, { tablePrefix: '' });
		expect(lookup.byTable('persons')).toEqual({ name: 'person', plural: 'persons' });
		// `people` is what pluralize('person') gives; nothing declares it.
		expect(lookup.byTable('people')).toBeNull();
	});

	it('a `table:`, not the plural, is the key a foreign_key: resolves through (TABLE-0)', () => {
		const dir = tmp();
		fs.writeFileSync(
			path.join(dir, 'ticket.yaml'),
			'entity:\n  name: ticket\n  plural: tickets\n  table: issues\n',
		);
		const lookup = createEntityLookup(dir, { tablePrefix: 'app_' });
		expect(lookup.byTable('issues')?.name).toBe('ticket');
		expect(lookup.byTable('tickets')).toBeNull();
		expect(lookup.byTable('app_tickets')).toBeNull();
	});

	it('the project prefix reaches the key; an entity table_prefix overrides it (TABLE-0)', () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, 'note.yaml'), 'entity:\n  name: note\n  plural: notes\n');
		fs.writeFileSync(path.join(dir, 'deal.yaml'), "entity:\n  name: deal\n  plural: deals\n  table_prefix: crm__\n");
		const lookup = createEntityLookup(dir, { tablePrefix: 'app_' });
		expect(lookup.byTable('app_notes')?.name).toBe('note');
		expect(lookup.byTable('crm__deals')?.name).toBe('deal');
		expect(lookup.byTable('notes')).toBeNull();
	});

	it('requires the prefix', () => {
		// @ts-expect-error — the missing key is the point
		expect(() => createEntityLookup(tmp(), {})).toThrow(/tablePrefix/);
	});

	it('a missing directory resolves nothing (the callers decide whether that is an error)', () => {
		const lookup = createEntityLookup(path.join(tmp(), 'absent'), { tablePrefix: '' });
		expect(lookup('person')).toBeNull();
		expect(lookup.byTable('persons')).toBeNull();
	});
});

describe('entityLookupFrom', () => {
	it('is the same lookup over blocks in hand', () => {
		const lookup = entityLookupFrom([{ name: 'person', plural: 'persons' }]);
		expect(lookup('person')).toEqual({ name: 'person', plural: 'persons' });
		expect(lookup.byTable('persons')?.name).toBe('person');
		expect(entityLookupFrom([{ name: 'person', plural: 'persons' }], { tablePrefix: 'x_' }).byTable('x_persons')?.name).toBe(
			'person',
		);
		expect(lookup('crew')).toBeNull();
	});
});

describe('createEntityLookup — the CLI walk and its guards', () => {
	it('skips dot-directories, as findYamlFiles does', () => {
		const dir = tmp();
		fs.mkdirSync(path.join(dir, '.cache'));
		fs.writeFileSync(path.join(dir, '.cache', 'ghost.yaml'), 'entity:\n  name: ghost\n  plural: ghosts\n');
		expect(createEntityLookup(dir, { tablePrefix: '' })('ghost')).toBeNull();
	});

	it('two YAMLs declaring the same plural is a load error naming both files', () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, 'person.yaml'), 'entity:\n  name: person\n  plural: persons\n');
		fs.writeFileSync(path.join(dir, 'human.yaml'), 'entity:\n  name: human\n  plural: persons\n');
		const lookup = createEntityLookup(dir, { tablePrefix: '' });
		expect(() => lookup('person')).toThrow(
			`two entity YAMLs declare the plural 'persons': ${path.join(dir, 'human.yaml')} and ${path.join(dir, 'person.yaml')}`,
		);
		expect(() => entityLookupFrom([{ name: 'a', plural: 'x' }, { name: 'b', plural: 'x' }])('a')).toThrow(
			"two entity YAMLs declare the plural 'x'",
		);
	});

	it('two YAMLs resolving to one SQL table is a load error naming both files (TABLE-0, #800)', () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, 'artifact.yaml'), 'entity:\n  name: artifact\n  plural: artifacts\n');
		fs.writeFileSync(
			path.join(dir, 'slack_message.yaml'),
			'entity:\n  name: slack_message\n  plural: slack_messages\n  table: artifacts\n',
		);
		const lookup = createEntityLookup(dir, { tablePrefix: '' });
		expect(() => lookup('artifact')).toThrow(
			`two entity YAMLs resolve to the SQL table 'artifacts': ${path.join(dir, 'artifact.yaml')} and ` +
				`${path.join(dir, 'slack_message.yaml')}. A table has one owning entity (two entities over one table is #800).`,
		);
	});

	it('names the directory searched and the file expected', () => {
		const dir = tmp();
		const lookup = createEntityLookup(dir, { candidates: [dir], tablePrefix: '' });
		expect(lookup.missingEntity('ghost')).toBe(
			`no YAML under ${dir} declares \`entity: { name: ghost }\` (expected e.g. ${path.join(dir, 'ghost.yaml')})`,
		);
		expect(lookup.missingTable('ghosts')).toBe(
			`no YAML under ${dir} resolves to the SQL table 'ghosts' — a \`table: ghosts\`, ` +
				"or a `plural:` that is 'ghosts' under the table prefix ''",
		);
		const none = createEntityLookup(null, { candidates: ['/p/defs', '/p/entities'], tablePrefix: '' });
		expect(none.missingEntity('ghost')).toContain('no entities directory exists (looked for /p/defs, /p/entities');
	});
});

describe('projectEntityLookup — the CLI rule, cached per process', () => {
	it('reads only the configured directory — no fallback to <cwd>/entities (PATH-0)', () => {
		const cwd = tmp();
		fs.writeFileSync(path.join(cwd, 'codegen.config.yaml'), 'paths:\n  entities: stale/dir\n');
		fs.mkdirSync(path.join(cwd, 'entities'));
		fs.writeFileSync(path.join(cwd, 'entities', 'person.yaml'), 'entity:\n  name: person\n  plural: persons\n');
		expect(projectEntityLookup(cwd)('person')?.plural).toBeUndefined();
	});

	it('finds codegen.config.yaml upward and honours paths.entities', () => {
		const root = tmp();
		fs.writeFileSync(path.join(root, 'codegen.config.yaml'), 'paths:\n  entities: defs\n');
		const cwd = path.join(root, 'defs');
		fs.mkdirSync(path.join(cwd, 'defs'), { recursive: true });
		fs.writeFileSync(path.join(cwd, 'defs', 'crew.yaml'), 'entity:\n  name: crew\n  plural: crews\n');
		expect(projectEntityLookup(cwd)('crew')?.plural).toBe('crews');
	});

	it('returns one lookup per resolved directory', () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, 'entities'));
		expect(projectEntityLookup(cwd)).toBe(projectEntityLookup(cwd));
	});
});

