/**
 * TGT-2a: `deriveTableColumns` is the one owner of a table's column list — every column, whatever made it, in the
 * order the Postgres template declares them, as facts with no target text.
 */

import { describe, expect, it } from 'bun:test';
import { deriveFieldFacts } from '../../../derived/columns/fields';
import { deriveTableColumns, fieldColumn } from '../../../derived/tables/columns';

const fields = deriveFieldFacts(
	{
		title: { type: 'string', required: true, max_length: 80 },
		amount: { type: 'decimal' },
		done: { type: 'boolean', default: false },
		due_on: { type: 'date', default: 'now' },
		seen_at: { type: 'datetime', timezone: false },
		meta: { type: 'json' },
		tags: { type: 'string_array' },
		status: { type: 'enum', choices: ['open', 'closed'], required: true },
		ref: { type: 'entity_ref' },
	},
	'note',
	null,
);

const base = {
	isChild: false,
	inherited: null,
	matched: [],
	belongsTo: [],
	fields: [],
	externalIdTracking: false,
	tenant: null,
	timestamps: null,
	softDelete: null,
} as const;

describe('deriveTableColumns', () => {
	it('every group, in the template’s order', () => {
		const cols = deriveTableColumns({
			isChild: true,
			inherited: {
				kind: { column: 'kind', prop: 'kind', as: 'meeting' },
				tenant: { column: 'tenant_id', prop: 'tenantId' },
			},
			matched: [{ column: 'owner_kind', prop: 'ownerKind', nullable: true, kind: 'field', field: { type: 'string' } }],
			belongsTo: [{ field: 'account_id', camelField: 'accountId', nullable: false }],
			fields: fields.slice(0, 1),
			externalIdTracking: true,
			tenant: { column: 'org_id', prop: 'orgId' },
			timestamps: { withTimezone: true },
			softDelete: { withTimezone: true },
		});
		expect(cols.map((c) => `${c.origin}:${c.name}`)).toEqual([
			'id:id',
			'inherited:kind',
			'inherited:tenant_id',
			'match:owner_kind',
			'belongs_to:account_id',
			'field:title',
			'behavior:external_id_tracking:external_id',
			'behavior:external_id_tracking:provider',
			'behavior:external_id_tracking:provider_metadata',
			'tenant:org_id',
			'behavior:timestamps:created_at',
			'behavior:timestamps:updated_at',
			'behavior:soft_delete:deleted_at',
		]);
		// A child's id is its base row's: the application makes none.
		expect(cols[0]!.generatedId).toBe(false);
		expect(cols[1]).toMatchObject({ kind: 'enum', choices: ['meeting'], default: { value: 'meeting' }, nullable: false });
		expect(cols.find((c) => c.name === 'created_at')).toMatchObject({ kind: 'instant', default: { now: true }, nullable: false });
	});

	it('a plain entity’s id is made by the application', () => {
		expect(deriveTableColumns(base)[0]).toMatchObject({ name: 'id', kind: 'uuid', generatedId: true, nullable: false });
	});

	it('field kinds, defaults and rules', () => {
		const by = Object.fromEntries(fields.map((f) => [f.name, fieldColumn(f)]));
		expect(by.title).toMatchObject({ kind: 'string', maxLength: 80, nullable: false });
		expect(by.amount).toMatchObject({ kind: 'decimal', nullable: true });
		expect(by.done).toMatchObject({ kind: 'boolean', default: { value: false } });
		expect(by.due_on).toMatchObject({ kind: 'date', default: { now: true } });
		expect(by.seen_at).toMatchObject({ kind: 'instant', withTimezone: false });
		expect(by.meta).toMatchObject({ kind: 'json' });
		expect(by.tags).toMatchObject({ kind: 'string', isArray: true });
		expect(by.status).toMatchObject({ kind: 'enum', choices: ['open', 'closed'], nullable: false });
		// An unrecognised type stores text, as every renderer treats it.
		expect(by.ref).toMatchObject({ kind: 'string' });
	});

	it('facts hold no target text', () => {
		const text = JSON.stringify(deriveTableColumns({ ...base, fields, timestamps: { withTimezone: true } }));
		for (const builder of ['varchar(', 'text(', 'timestamp(', 'pgTable', 'sqliteTable', 'TEXT', 'NOT NULL', 'z.']) {
			expect(text).not.toContain(builder);
		}
	});
});
