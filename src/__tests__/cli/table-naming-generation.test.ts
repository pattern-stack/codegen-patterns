/**
 * TABLE-0 end to end: the real CLI (`entity new --all` +
 * `junction new --all`) over a project with `tables.prefix`, an entity with
 * `table_name:`, an entity opting out with `table_prefix: ''`, and a junction —
 * then a relation include through the GENERATED relations manifest, compiled to
 * SQL by Drizzle. The SQL names the real tables; the code names the entities.
 *
 * The project lives under `test/tmp/` (gitignored) so the generated files
 * resolve this checkout's `drizzle-orm`, and its `tsconfig.json` maps the
 * vendored `@shared/*` runtime onto `runtime/`, as `test/tsconfig.baseline.json`
 * does. The include is compiled in a child `bun` so that mapping applies.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dir, '../../..');
const CLI = path.join(REPO, 'src/cli/index.ts');
let root = '';

const write = (rel: string, body: string) => {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, body);
};
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const bun = (args: string[]) => {
	const r = spawnSync('bun', args, { cwd: root, encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`bun ${args.join(' ')} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
	return r.stdout;
};

beforeAll(() => {
	fs.mkdirSync(path.join(REPO, 'test/tmp'), { recursive: true });
	root = fs.mkdtempSync(path.join(REPO, 'test/tmp/table-naming-'));
	write('codegen.config.yaml', 'runtime: vendored\npaths:\n  entities: entities\ntables:\n  prefix: app_\n');
	write(
		'tsconfig.json',
		JSON.stringify({
			compilerOptions: {
				experimentalDecorators: true,
				paths: { '@shared/*': [path.relative(root, path.join(REPO, 'runtime')) + '/*'] },
			},
		}),
	);
	// A renamed concept over a legacy table: the concept is Ticket, the table is still `issues`.
	write(
		'entities/ticket.yaml',
		[
			'entity:',
			'  name: ticket',
			'  plural: tickets',
			'  table_name: issues',
			'  pattern: Base',
			'  expose: [repository]',
			'api: false',
			'tenant_scoped: true',
			'fields:',
			'  name: { type: string, required: true, index: true }',
			'relationships:',
			'  versions: { type: has_many, target: ticket_revision, foreign_key: ticket_id }',
			'behaviors: [timestamps]',
			'',
		].join('\n'),
	);
	// Takes the project prefix.
	write(
		'entities/ticket_revision.yaml',
		[
			'entity:',
			'  name: ticket_revision',
			'  plural: ticket_revisions',
			'  pattern: Base',
			'  expose: [repository]',
			'api: false',
			'tenant_scoped: true',
			'fields:',
			'  label: { type: string }',
			'  derived_from_id: { type: uuid, foreign_key: issues.id }',
			'relationships:',
			'  ticket: { type: belongs_to, target: ticket, foreign_key: ticket_id, nullable: false }',
			'behaviors: [timestamps]',
			'',
		].join('\n'),
	);
	// Opts out of the project prefix.
	write(
		'entities/tag.yaml',
		[
			'entity:',
			'  name: tag',
			'  plural: tags',
			"  table_prefix: ''",
			'  pattern: Base',
			'  expose: [repository]',
			'api: false',
			'fields:',
			'  label: { type: string, required: true }',
			'',
		].join('\n'),
	);
	write('junctions/ticket_tag.yaml', 'pattern: Junction\nbetween: [ticket, tag]\n');

	bun([CLI, 'entity', 'new', '--all', '--force']);
	bun([CLI, 'junction', 'new', '--all', '--force']);
});

afterAll(() => {
	if (root && !process.env.KEEP_SMOKE_DIR) fs.rmSync(root, { recursive: true, force: true });
});

describe('TABLE-0 — generated tables', () => {
	it('table_name: the export is the plural, the SQL table is the table_name (no prefix)', () => {
		const out = read('src/modules/tickets/ticket.entity.ts');
		expect(out).toContain("export const tickets = pgTable(\n  'issues',");
		expect(out).toContain("index('issues_tenant_id_idx')");
		expect(out).toContain("index('issues_name_idx')");
	});

	it('tables.prefix reaches an entity with neither key', () => {
		const out = read('src/modules/ticket-revisions/ticket-revision.entity.ts');
		expect(out).toContain("export const ticket_revisions = pgTable(\n  'app_ticket_revisions',");
		expect(out).toContain("index('app_ticket_revisions_tenant_id_idx')");
	});

	it("a field foreign_key: names the SQL table and references the owner's export", () => {
		const out = read('src/modules/ticket-revisions/ticket-revision.entity.ts');
		expect(out).toContain("import { tickets } from '../tickets/ticket.entity';");
		expect(out).toContain("derivedFromId: uuid('derived_from_id').references((): AnyPgColumn => tickets.id)");
	});

	it("table_prefix: '' opts out", () => {
		expect(read('src/modules/tags/tag.entity.ts')).toContain("export const tags = pgTable(\n  'tags',");
	});

	it('a junction takes the prefix on its SQL table; its export and folder stay derived', () => {
		const out = read('src/modules/ticket-tags/ticket-tag.entity.ts');
		expect(out).toContain("export const ticketTags = pgTable(\n  'app_ticket_tags',");
	});

	it('the relations manifest keys and db.query names are the code vocabulary, never the table', () => {
		const rel = read('src/generated/relations.ts');
		expect(rel).toContain('\ttickets: {');
		expect(rel).toContain('r.many.ticket_revisions({ from: r.tickets.id, to: r.ticket_revisions.ticketId');
		expect(rel).not.toMatch(/\bissues\b/);
		expect(rel).not.toContain('app_');
	});

	it('a relation include across the renamed table compiles to SQL over the real tables', () => {
		write(
			'include-sql.ts',
			[
				"import { drizzle } from 'drizzle-orm/node-postgres';",
				"import { relations } from './src/generated/relations';",
				"import { withRequester } from '@shared/base-classes/tenant-context';",
				'const db = drizzle.mock({ relations });',
				"await withRequester({ userId: 'u', tenantId: '00000000-0000-0000-0000-000000000001' } as never, async () => {",
				'  const q = db.query.tickets.findMany({ with: { versions: true, tags: true } });',
				'  console.log(q.toSQL().sql);',
				'});',
				'',
			].join('\n'),
		);
		const sql = bun(['include-sql.ts']);
		const tables = [...sql.matchAll(/(?:from|join) "([a-z_]+)"/g)].map((m) => m[1]);
		expect(tables).toEqual(['issues', 'app_ticket_revisions', 'tags', 'app_ticket_tags']);
		// The JSON keys the caller reads are the relation names, not table names.
		expect(sql).toContain('as "versions"');
		expect(sql).toContain('as "tags"');
	});
});
