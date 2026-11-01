/**
 * #813 — emitted code must not be breakable by an entity name or plural that
 * validation accepts. Two rules (see test/_emitted-name-hygiene.ts):
 *   1. no unqualified lib global type in a file where an entity type is in scope
 *      (except the reserved Promise / Array / Date);
 *   2. no plural-shaped binding in a function that reads a table export by name.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ejs from 'ejs';
import promptModule from '../../../templates/relationship/new/prompt.js';
import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
import { emittedNameViolations, libGlobalTypeNames } from '../../../test/_emitted-name-hygiene';
import { withEntities } from '../backend/_entity-lookup';

const ROOT = path.resolve(import.meta.dir, '../../..');
const BACKEND_ROOT = path.join(ROOT, 'templates/entity/new/backend');

function walk(dir: string, ext: RegExp, acc: { path: string; text: string }[] = []) {
	if (!fs.existsSync(dir)) return acc;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walk(full, ext, acc);
		else if (ext.test(e.name)) acc.push({ path: path.relative(ROOT, full), text: fs.readFileSync(full, 'utf8') });
	}
	return acc;
}

const fmt = (v: ReturnType<typeof emittedNameViolations>) =>
	v.map((x) => `${x.path}:${x.line} ${x.rule} ${x.name} — ${x.detail}`);

describe('emitted-name hygiene helper', () => {
	const entityFile = (body: string) => [
		{ path: 'a.ts', text: `import { items, type Item } from './item.entity';\n${body}` },
	];

	it('knows the lib globals', () => {
		const lib = libGlobalTypeNames();
		for (const n of ['Record', 'Partial', 'Map', 'Promise', 'Array', 'Date', 'PropertyKey']) {
			expect(lib.has(n)).toBe(true);
		}
		expect(lib.has('Item')).toBe(false);
	});

	it('flags Record<…> in a file that imports from an entity module', () => {
		const v = emittedNameViolations(entityFile('export type X = Record<string, never>;'));
		expect(v.map((x) => x.name)).toEqual(['Record']);
	});
	it('passes globalThis.Record, Promise, Array and Date', () => {
		const src =
			'export type X = globalThis.Record<string, never>;\n' +
			'export async function f(): Promise<Array<Date>> { return []; }';
		expect(emittedNameViolations(entityFile(src))).toEqual([]);
	});
	it('ignores a file with no entity import', () => {
		expect(emittedNameViolations([{ path: 'b.ts', text: 'export type X = Record<string, never>;' }])).toEqual([]);
	});
	it('does not flag a name the file binds itself', () => {
		const src = "import type { Map } from './x';\nexport type X = Map<string, string>;";
		expect(emittedNameViolations(entityFile(src))).toEqual([]);
	});
	it('flags const [items, total] in a function that reads an imported items', () => {
		const src = 'export async function run() { const isKnown = items.id; const [items, total] = await g(); return isKnown; }';
		expect(emittedNameViolations(entityFile(src)).map((x) => x.name)).toEqual(['items', 'total']);
	});
	it('flags parameter options when the body reads table export options', () => {
		const src = "import { options } from './option.entity';\nexport function run(options: number) { return options; }";
		const v = emittedNameViolations([{ path: 'c.ts', text: src }]);
		expect(v.map((x) => x.name)).toEqual(['options']);
	});
	it('passes the same bindings in a function that does not read a table export', () => {
		const src = 'export async function run() { const [rows, total] = await g(); const options = 1; return rows; }';
		expect(emittedNameViolations(entityFile(src))).toEqual([]);
	});
	it('passes camelCase bindings', () => {
		const src = 'export async function run() { const isKnown = items.id; const [pageRows, rowTotal] = await g(); return isKnown; }';
		expect(emittedNameViolations(entityFile(src))).toEqual([]);
	});
});

describe('committed trees obey the rule', () => {
	it.each([
		['test/baseline/packages/api/src', /\.ts$/],
		['test/frontend-golden/snapshot', /\.ts$/],
		['test/frontend-graph-golden/snapshot', /\.ts$/],
	])('%s', (dir, ext) => {
		const files = walk(path.join(ROOT, dir), ext);
		expect(files.length).toBeGreaterThan(5);
		expect(fmt(emittedNameViolations(files))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Branch matrix — what the baseline fixtures do not render.
// ---------------------------------------------------------------------------

function walkTemplates(dir: string, acc: string[] = []): string[] {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walkTemplates(full, acc);
		else if (e.name.endsWith('.ejs.t')) acc.push(full);
	}
	return acc;
}

function body(file: string): string {
	const source = fs.readFileSync(file, 'utf8');
	return source.slice(source.indexOf('\n---\n', 4) + 5);
}

function renderAll(def: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	const l = { ...(buildBackendLocals(def, withEntities()) as Record<string, unknown>), ...extra };
	const out: { path: string; text: string }[] = [];
	for (const t of walkTemplates(BACKEND_ROOT)) {
		const rel = path.relative(BACKEND_ROOT, t).replace(/\.ejs\.t$/, '.ts').replace(/\//g, '__');
		out.push({ path: `${def.entity ? (def.entity as any).name : 'x'}/${rel}`, text: ejs.render(body(t), l) });
	}
	return out;
}

const base = {
	entity: { name: 'record', plural: 'records', table: 'records', pattern: 'Base' },
	fields: { title: { type: 'string', required: true }, status: { type: 'enum', choices: ['open', 'closed'] } },
	relationships: { account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } },
	behaviors: ['timestamps'],
};

const MATRIX: [string, Record<string, unknown>, Record<string, unknown>][] = [
	['an entity named record with plural options', { ...base, entity: { ...base.entity, plural: 'options', table: 'options' } }, {}],
	[
		'an eav entity',
		{ ...base, entity: { ...base.entity, name: 'opportunity', plural: 'opportunities', table: 'opportunities', pattern: 'Integrated' }, eav: true },
		{},
	],
	[
		'an eav_value_table entity',
		{
			entity: { name: 'field_value', plural: 'field_values', table: 'field_values', pattern: 'Metadata' },
			eav_value_table: true,
			eav_definition_table: 'field_definition',
			fields: {
				entity_type: { type: 'string', required: true },
				entity_id: { type: 'uuid', required: true },
				field_definition_id: { type: 'uuid', required: true },
				user_id: { type: 'uuid', required: true },
				value: { type: 'json', required: true },
			},
			relationships: {},
			behaviors: ['timestamps'],
		},
		{},
	],
	[
		'an integration-surface entity with detection',
		base,
		{
			hasDetection: true,
			detectionConfigsLiteral: '{ "hubspot-crm": { "mode": "poll" } }',
		},
	],
	[
		'an entity with a two-field select query',
		{ ...base, queries: [{ by: ['status'], select: ['title', 'status'] }] },
		{},
	],
	[
		'a service with a capability forwarder',
		base,
		{ capabilityForwarders: [{ capability: 'searchable', method: 'searchText' }] },
	],
];

describe('branch matrix', () => {
	it.each(MATRIX)('%s', (_name, def, extra) => {
		const files = renderAll(def, extra);
		expect(fmt(emittedNameViolations(files))).toEqual([]);
	});
});

describe('relationship prompt select: return type', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	});

	it('is globalThis.Pick<…>[] for a two-field select', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-hygiene-'));
		dirs.push(dir);
		fs.mkdirSync(path.join(dir, 'entities'));
		fs.writeFileSync(path.join(dir, 'entities/person.yaml'), 'entity:\n  name: person\n  plural: persons\n');
		fs.writeFileSync(path.join(dir, 'entities/crew.yaml'), 'entity:\n  name: crew\n  plural: crews\n');
		const file = path.join(dir, 'relationship.yaml');
		fs.writeFileSync(
			file,
			'relationship:\n  name: person_crew\n  from: person\n  to: crew\n' +
				'fields:\n  role:\n    type: string\n  rank:\n    type: string\n' +
				'queries:\n  - by: [person_id]\n    select: [role, rank]\n',
		);
		const cwd = process.cwd();
		process.chdir(dir);
		try {
			const locals = (await promptModule.prompt({ args: { yaml: file } })) as Record<string, any>;
			const types = JSON.stringify(locals.processedQueries.map((q: any) => q.returnType));
			expect(types).toContain('globalThis.Pick<');
			expect(types).not.toMatch(/[^.]Pick</);
		} finally {
			process.chdir(cwd);
		}
	});
});
