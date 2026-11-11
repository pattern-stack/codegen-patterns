/**
 * TABLE-0 — the SQL table name is decoupled from the code names.
 *
 * `pgTable('…')` and every index / constraint name read the SQL table name
 * (`sqlTableName`, `src/config/table-naming.ts`); the Drizzle export, folder and
 * classes stay on `plural`. The default (no `table_name`, no prefix) is pinned
 * byte-for-byte by `just test-baseline`; this file pins the four new shapes and
 * the `foreign_key:` resolution across a renamed table.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
import { entityLookupFrom } from '../../../templates/_shared/entity-naming.mjs';
import { sqlTableName } from '../../config/table-naming';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';
import { JunctionDefinitionSchema } from '../../schema/junction-definition.schema';
import { CodegenConfigSchema } from '../../schema/codegen-config.schema';
import { junctionTableName } from '../../config/junction-naming';
import { withEntities } from './_entity-lookup';

function template(rel: string): string {
	const source = readFileSync(resolve(import.meta.dir, '../../../templates/entity/new/backend', rel), 'utf8');
	const lines = source.split('\n');
	return lines.slice(lines.indexOf('---', 1) + 1).join('\n');
}
const renderEntity = (locals: Record<string, unknown>) =>
	ejs.render(template('entity.ejs.t'), locals, { rmWhitespace: false });

/** A renamed concept over a legacy table: Ticket's table is still `issues`. */
const ticket = (entity: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
	entity: { name: 'ticket', plural: 'tickets', pattern: 'Base', ...entity },
	fields: {
		name: { type: 'string', required: true, index: true },
		slug: { type: 'string', required: true, unique: true },
	},
	relationships: {},
	behaviors: ['timestamps'],
	tenant_scoped: true,
	...extra,
});

const localsFor = (def: Record<string, unknown>, base: Record<string, unknown> = {}) =>
	buildBackendLocals(def, withEntities(base));

describe('sqlTableName — the one rule', () => {
	it('defaults to the plural: byte-identical to the output before the split', () => {
		expect(sqlTableName({ name: 'deal', plural: 'deals' }, '')).toBe('deals');
	});
	it('table_name is taken verbatim; no prefix reaches it', () => {
		expect(sqlTableName({ name: 'ticket', plural: 'tickets', table_name: 'issues' }, 'app_')).toBe('issues');
	});
	it('the project prefix composes with the plural', () => {
		expect(sqlTableName({ name: 'deal', plural: 'deals' }, 'crm__')).toBe('crm__deals');
	});
	it("an entity table_prefix overrides the project's; '' opts out", () => {
		expect(sqlTableName({ name: 'deal', plural: 'deals', table_prefix: 'sales__' }, 'crm__')).toBe('sales__deals');
		expect(sqlTableName({ name: 'deal', plural: 'deals', table_prefix: '' }, 'crm__')).toBe('deals');
	});
	it('a missing project prefix throws — never an unprefixed or "undefined…" table', () => {
		// @ts-expect-error — the missing argument is the point
		expect(() => sqlTableName({ name: 'deal', plural: 'deals' })).toThrow(/project table prefix is required/);
	});
	it('junctions use the same rule over their derived plural', () => {
		expect(junctionTableName({ between: ['opportunity', 'contact'] }, '')).toBe('opportunity_contacts');
		expect(junctionTableName({ between: ['opportunity', 'contact'] }, 'crm__')).toBe('crm__opportunity_contacts');
		expect(junctionTableName({ between: ['opportunity', 'contact'], table_name: 'deal_people' }, 'crm__')).toBe(
			'deal_people',
		);
		expect(junctionTableName({ between: ['opportunity', 'contact'], table_prefix: '' }, 'crm__')).toBe(
			'opportunity_contacts',
		);
	});
});

describe('entity.ejs.t — table_name', () => {
	const out = renderEntity(localsFor(ticket({ table_name: 'issues' })));

	it('the export is the plural; the pgTable argument is the SQL table', () => {
		expect(out).toContain("export const tickets = pgTable(\n  'issues',");
		expect(out).toContain('export type Ticket = InferSelectModel<typeof tickets>;');
	});

	it('index and constraint names are stemmed on the SQL table', () => {
		expect(out).toContain("index('issues_tenant_id_idx').on(t.tenantId)");
		expect(out).toContain("index('issues_name_idx').on(t.name)");
		expect(out).toContain("unique('issues_tenant_id_slug_uniq')");
		expect(out).not.toContain("'tickets");
	});

	it('the module folder and class names stay on the code vocabulary', () => {
		const locals = localsFor(ticket({ table_name: 'issues' })) as Record<string, any>;
		expect(locals.entityTableName).toBe('issues');
		expect(locals.entityNamePlural).toBe('tickets');
		expect(locals.outputPaths.entity).toContain('/tickets/ticket.entity.ts');
		expect(locals.classNames.entityTable).toBe('tickets');
		expect(locals.classNames.repository).toBe('TicketRepository');
	});
});

describe('entity.ejs.t — table_prefix', () => {
	it('the project prefix reaches pgTable and the index names, not the export', () => {
		const out = renderEntity(localsFor(ticket(), { tablePrefix: 'support__' }));
		expect(out).toContain("export const tickets = pgTable(\n  'support__tickets',");
		expect(out).toContain("index('support__tickets_tenant_id_idx')");
		expect(out).toContain("unique('support__tickets_tenant_id_slug_uniq')");
	});

	it('an entity table_prefix overrides the project prefix', () => {
		const out = renderEntity(localsFor(ticket({ table_prefix: 'helpdesk__' }), { tablePrefix: 'support__' }));
		expect(out).toContain("pgTable(\n  'helpdesk__tickets',");
		expect(out).not.toContain('support__');
	});

	it("table_prefix: '' opts one entity out of the project prefix", () => {
		const out = renderEntity(localsFor(ticket({ table_prefix: '' }), { tablePrefix: 'support__' }));
		expect(out).toContain("pgTable(\n  'tickets',");
		expect(out).not.toContain('support__');
	});

	it('table_name ignores the project prefix', () => {
		const out = renderEntity(localsFor(ticket({ table_name: 'issues' }), { tablePrefix: 'support__' }));
		expect(out).toContain("pgTable(\n  'issues',");
		expect(out).not.toContain('support__');
	});
});

describe('field-level foreign_key: names the SQL table, imports the export', () => {
	const match = {
		entity: { name: 'ticket_link', plural: 'ticket_links', table_name: 'issue_links', pattern: 'Base' },
		fields: {
			ticket_id: { type: 'uuid', required: true, foreign_key: 'issues.id' },
			parent_id: { type: 'uuid', foreign_key: 'issue_links.id' },
		},
		relationships: {},
		behaviors: [],
	};
	const targets = [{ name: 'ticket', plural: 'tickets', table_name: 'issues' }];
	const locals = (prefix = '') => ({
		...withEntities({ tablePrefix: prefix, ownedTableNames: ['issues', 'issue_links'] }),
		entityLookup: entityLookupFrom(targets, { tablePrefix: prefix }),
	});

	it('resolves `issues` to the Ticket entity and references its export', () => {
		const out = renderEntity(buildBackendLocals(match, locals()));
		expect(out).toContain("import { tickets } from '../tickets/ticket.entity';");
		expect(out).toContain("ticketId: uuid('ticket_id').notNull().references((): AnyPgColumn => tickets.id)");
	});

	it('a self-reference by SQL table name references its own export, no import', () => {
		const out = renderEntity(buildBackendLocals(match, locals()));
		expect(out).toContain("parentId: uuid('parent_id').references((): AnyPgColumn => ticket_links.id)");
		expect(out).not.toContain('ticket-link.entity');
	});

	it('naming the export instead of the table is an error that says which table it looked for', () => {
		const wrong = { ...match, fields: { ticket_id: { type: 'uuid', foreign_key: 'tickets.id' } } };
		expect(() =>
			buildBackendLocals(wrong, {
				...locals(),
				ownedTableNames: ['issues', 'issue_links', 'tickets'],
			}),
		).toThrow("the table 'tickets' is not owned by any entity YAML");
	});
});

describe('schema — table_name / table_prefix', () => {
	const base = { fields: { id: { type: 'uuid', required: true } } };
	const parse = (entity: Record<string, unknown>) =>
		EntityDefinitionSchema.safeParse({ ...base, entity: { name: 'ticket', plural: 'tickets', ...entity } });

	it('both are optional', () => {
		expect(parse({}).success).toBe(true);
		expect(parse({ table_name: 'issues' }).success).toBe(true);
		expect(parse({ table_prefix: 'support__' }).success).toBe(true);
		expect(parse({ table_prefix: '' }).success).toBe(true);
	});

	it('they are mutually exclusive — table_name takes no prefix', () => {
		const r = parse({ table_name: 'issues', table_prefix: 'support__' });
		expect(r.success).toBe(false);
		expect(JSON.stringify(r.error?.issues)).toContain('mutually exclusive');
	});

	it('both must be lowercase snake_case', () => {
		expect(parse({ table_name: 'Issues' }).success).toBe(false);
		expect(parse({ table_prefix: 'Agentic__' }).success).toBe(false);
	});

	it('the old `table:` key is an unrecognized key — it never reached pgTable', () => {
		const r = parse({ table: 'issues' });
		expect(r.success).toBe(false);
		expect(r.error?.issues[0]?.code).toBe('unrecognized_keys');
	});

	it('a junction accepts the same two keys, exclusively', () => {
		const j = (extra: Record<string, unknown>) =>
			JunctionDefinitionSchema.safeParse({ pattern: 'Junction', between: ['opportunity', 'contact'], ...extra });
		expect(j({ table_name: 'deal_people' }).success).toBe(true);
		expect(j({ table_prefix: 'crm__' }).success).toBe(true);
		expect(j({ table_name: 'deal_people', table_prefix: 'crm__' }).success).toBe(false);
	});

	it('codegen.config.yaml: tables.prefix defaults to empty and is validated', () => {
		expect(CodegenConfigSchema.parse({}).tables.prefix).toBe('');
		expect(CodegenConfigSchema.parse({ tables: { prefix: 'app_' } }).tables.prefix).toBe('app_');
		expect(CodegenConfigSchema.safeParse({ tables: { prefix: 'App' } }).success).toBe(false);
		expect(CodegenConfigSchema.safeParse({ tables: { schema: 'x' } }).success).toBe(false);
	});
});
