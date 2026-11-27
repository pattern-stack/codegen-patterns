/**
 * `deriveTableColumns`: every column a generated entity table has, as facts, in the order the table declares them
 * (TGT-2a). The ONE owner of "which columns does this table have": the Postgres template prints its own text per group
 * and reads this list for every column lookup (`entity-locals.js`'s `tableColumns`); the SQLite DDL renders it whole.
 *
 * Order (the Postgres template's, `entity.ejs.t`): `id`; a child's inherited kind / tenant copies; `belongs_to` foreign
 * keys; `match:`-derived columns; declared fields; `external_id_tracking`'s three; an emitted tenant column; `timestamps`;
 * `soft_delete`.
 *
 * Pure, and hygen-safe (reached from `entity-locals.js`): it imports only shipped `src/` modules.
 */

import { deriveFieldFacts } from '../columns/fields.js';
import type { FieldFacts } from '../columns/types.js';
import type { ColumnDefault, ColumnFact, ColumnKind } from './types.js';

/** A `match:`-derived column, as `matchColumns` (`templates/_shared/inheritance.mjs`) resolves it. */
export interface MatchedColumnInput {
	readonly column: string;
	readonly prop: string;
	readonly nullable: boolean;
	/** `fk`: the target's `id`; `field`: one of the target's fields. */
	readonly kind: 'fk' | 'field';
	/** The target field's YAML, when `kind` is `field`. */
	readonly field?: Readonly<Record<string, unknown>>;
	/** The target field's enum, when it is one. */
	readonly enumRef?: { readonly choices: readonly string[] } | null;
}

export interface TableColumnsInput {
	/** A joined-table child: its `id` is the base row's, so the application does not make one. */
	readonly isChild: boolean;
	/** A child's copies of its base's kind (fixed to `as`) and tenant columns; `null` for any other entity. */
	readonly inherited: {
		readonly kind: { readonly column: string; readonly prop: string; readonly as: string };
		readonly tenant: { readonly column: string; readonly prop: string } | null;
	} | null;
	readonly matched: readonly MatchedColumnInput[];
	readonly belongsTo: readonly { readonly field: string; readonly camelField: string; readonly nullable: boolean }[];
	/** The declared fields that are columns (a `belongs_to` FK field is the `belongs_to` column instead). */
	readonly fields: readonly FieldFacts[];
	readonly externalIdTracking: boolean;
	/** The tenant column this entity emits itself; `null` when it is not tenant-scoped or adopts a declared column. */
	readonly tenant: { readonly column: string; readonly prop: string } | null;
	readonly timestamps: { readonly withTimezone: boolean } | null;
	readonly softDelete: { readonly withTimezone: boolean } | null;
}

const NOW = /^(now|now\(\)|current_timestamp)$/i;

const FIELD_KINDS: Readonly<Record<string, ColumnKind>> = {
	string: 'string',
	integer: 'integer',
	decimal: 'decimal',
	boolean: 'boolean',
	uuid: 'uuid',
	date: 'date',
	datetime: 'instant',
	json: 'json',
};

const plain = {
	path: [] as readonly string[],
	isArray: false,
	default: null,
	choices: null,
	maxLength: null,
	withTimezone: null,
	generatedId: false,
} as const;

/** One declared field's column. An unrecognised type stores text, as every target's renderer treats it. */
export function fieldColumn(f: FieldFacts, origin: ColumnFact['origin'] = 'field'): ColumnFact {
	// An incomplete record (e.g. a template's processed field, which leaves facts out) must not become a TEXT column
	// with an `undefined` default by accident: refuse it (CLAUDE.md gate rule c).
	if (typeof f.elementType !== 'string' || typeof f.isArray !== 'boolean' || (f.hasDefault && f.default === undefined)) {
		throw new Error(`deriveTableColumns: '${f.name}' is not a complete FieldFacts (elementType / isArray / default).`);
	}
	const kind: ColumnKind = f.hasChoices ? 'enum' : (FIELD_KINDS[f.elementType] ?? 'string');
	let def: ColumnDefault | null = null;
	if (f.hasDefault) {
		def = (kind === 'instant' || kind === 'date') && typeof f.default === 'string' && NOW.test(f.default)
			? { now: true }
			: { value: f.default };
	}
	return {
		name: f.name,
		prop: f.camelName,
		path: [f.name],
		origin,
		kind,
		isArray: f.isArray,
		nullable: f.nullable,
		default: def,
		choices: f.hasChoices ? (f.choices ?? null) : null,
		maxLength: kind === 'string' ? f.maxLength : null,
		withTimezone: kind === 'instant' ? f.withTimezone : null,
		generatedId: false,
	};
}

export function deriveTableColumns(input: TableColumnsInput): ColumnFact[] {
	const cols: ColumnFact[] = [
		{ ...plain, name: 'id', prop: 'id', path: ['id'], origin: 'id', kind: 'uuid', nullable: false, generatedId: !input.isChild },
	];
	if (input.inherited) {
		const { kind, tenant } = input.inherited;
		cols.push({
			...plain,
			name: kind.column,
			prop: kind.prop,
			path: [kind.column],
			origin: 'inherited',
			kind: 'enum',
			nullable: false,
			default: { value: kind.as },
			choices: [kind.as],
		});
		if (tenant) {
			cols.push({ ...plain, name: tenant.column, prop: tenant.prop, path: [tenant.column], origin: 'inherited', kind: 'uuid', nullable: false });
		}
	}
	for (const rel of input.belongsTo) {
		cols.push({ ...plain, name: rel.field, prop: rel.camelField, path: [rel.field], origin: 'belongs_to', kind: 'uuid', nullable: rel.nullable });
	}
	for (const m of input.matched) {
		if (m.kind === 'fk') {
			cols.push({ ...plain, name: m.column, prop: m.prop, path: [m.column], origin: 'match', kind: 'uuid', nullable: m.nullable });
			continue;
		}
		// The target column's own type, none of its constraints (default / unique / index / FK) — as the Postgres
		// template renders it.
		const { type, max_length, min_length, timezone } = (m.field ?? {}) as Parameters<typeof deriveFieldFacts>[0][string];
		const [facts] = deriveFieldFacts(
			{ [m.column]: { type, max_length, min_length, timezone, ...(m.nullable ? {} : { required: true }) } },
			m.column,
			null,
		);
		const col = fieldColumn(facts!, 'match');
		cols.push(m.enumRef ? { ...col, kind: 'enum', choices: m.enumRef.choices } : col);
	}
	for (const f of input.fields) cols.push(fieldColumn(f));
	if (input.externalIdTracking) {
		const origin = 'behavior:external_id_tracking' as const;
		cols.push(
			{ ...plain, name: 'external_id', prop: 'externalId', path: ['external_id'], origin, kind: 'string', nullable: true },
			{ ...plain, name: 'provider', prop: 'provider', path: ['provider'], origin, kind: 'string', nullable: true },
			{ ...plain, name: 'provider_metadata', prop: 'providerMetadata', path: ['provider_metadata'], origin, kind: 'json', nullable: true },
		);
	}
	if (input.tenant) {
		const t = input.tenant;
		cols.push({ ...plain, name: t.column, prop: t.prop, path: [t.column], origin: 'tenant', kind: 'uuid', nullable: true });
	}
	if (input.timestamps) {
		const at = (name: string, prop: string): ColumnFact => ({
			...plain,
			name,
			prop,
			path: [name],
			origin: 'behavior:timestamps',
			kind: 'instant',
			nullable: false,
			default: { now: true },
			withTimezone: input.timestamps!.withTimezone,
		});
		cols.push(at('created_at', 'createdAt'), at('updated_at', 'updatedAt'));
	}
	if (input.softDelete) {
		cols.push({
			...plain,
			name: 'deleted_at',
			prop: 'deletedAt',
			path: ['deleted_at'],
			origin: 'behavior:soft_delete',
			kind: 'instant',
			nullable: true,
			withTimezone: input.softDelete.withTimezone,
		});
	}
	return cols;
}
