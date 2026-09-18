/**
 * The shared cross-entity naming module (NAME-0, #630 / #611) —
 * `templates/_shared/entity-naming.mjs`, read by the entity prompt, the
 * clean-lite-ps extension and the junction prompt.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	createEntityLookup,
	entityLookupFrom,
	entityModuleNaming,
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

describe('entityModuleNaming', () => {
	it('reads plural: as table export and folder — never pluralize(name)', () => {
		expect(entityModuleNaming({ name: 'person', plural: 'persons' }, 'src')).toEqual({
			plural: 'persons',
			moduleGroupDir: 'src/modules',
			moduleDir: 'src/modules/persons',
			entityFile: 'src/modules/persons/person.entity',
		});
	});

	it('nests the module folder under context:', () => {
		const naming = entityModuleNaming({ name: 'crew', plural: 'crews', context: 'org' }, 'src');
		expect(naming.moduleDir).toBe('src/modules/org/crews');
		expect(naming.entityFile).toBe('src/modules/org/crews/crew.entity');
	});
});

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
		const lookup = createEntityLookup(dir);
		expect(lookup('person')).toEqual({ name: 'person', plural: 'personnel', context: 'hr' });
		expect(lookup('nobody')).toBeNull();
	});

	it('resolves by declared plural — the table a field-level foreign_key: names', () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, 'person.yaml'), 'entity:\n  name: person\n  plural: persons\n');
		const lookup = createEntityLookup(dir);
		expect(lookup.byPlural('persons')).toEqual({ name: 'person', plural: 'persons' });
		// `people` is what pluralize('person') gives; nothing declares it.
		expect(lookup.byPlural('people')).toBeNull();
	});

	it('a missing directory resolves nothing (the callers decide whether that is an error)', () => {
		const lookup = createEntityLookup(path.join(tmp(), 'absent'));
		expect(lookup('person')).toBeNull();
		expect(lookup.byPlural('persons')).toBeNull();
	});
});

describe('entityLookupFrom', () => {
	it('is the same lookup over blocks in hand', () => {
		const lookup = entityLookupFrom([{ name: 'person', plural: 'persons' }]);
		expect(lookup('person')).toEqual({ name: 'person', plural: 'persons' });
		expect(lookup.byPlural('persons')?.name).toBe('person');
		expect(lookup('crew')).toBeNull();
	});
});

describe('createEntityLookup — the CLI walk and its guards', () => {
	it('skips dot-directories, as findYamlFiles does', () => {
		const dir = tmp();
		fs.mkdirSync(path.join(dir, '.cache'));
		fs.writeFileSync(path.join(dir, '.cache', 'ghost.yaml'), 'entity:\n  name: ghost\n  plural: ghosts\n');
		expect(createEntityLookup(dir)('ghost')).toBeNull();
	});

	it('two YAMLs declaring the same plural is a load error naming both files', () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, 'person.yaml'), 'entity:\n  name: person\n  plural: persons\n');
		fs.writeFileSync(path.join(dir, 'human.yaml'), 'entity:\n  name: human\n  plural: persons\n');
		const lookup = createEntityLookup(dir);
		expect(() => lookup('person')).toThrow(
			`two entity YAMLs declare the table 'persons': ${path.join(dir, 'human.yaml')} and ${path.join(dir, 'person.yaml')}`,
		);
		expect(() => entityLookupFrom([{ name: 'a', plural: 'x' }, { name: 'b', plural: 'x' }])('a')).toThrow(
			"two entity YAMLs declare the table 'x'",
		);
	});

	it('names the directory searched and the file expected', () => {
		const dir = tmp();
		const lookup = createEntityLookup(dir, [dir]);
		expect(lookup.missingEntity('ghost')).toBe(
			`no YAML under ${dir} declares \`entity: { name: ghost }\` (expected e.g. ${path.join(dir, 'ghost.yaml')})`,
		);
		expect(lookup.missingPlural('ghosts')).toBe(`no YAML under ${dir} declares \`plural: ghosts\``);
		const none = createEntityLookup(null, ['/p/defs', '/p/entities']);
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

