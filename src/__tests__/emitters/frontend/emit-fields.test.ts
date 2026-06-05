/**
 * Frontend emitter — field metadata tests (ADR-038, FE-3).
 *
 * Two layers: pure UI-derivation unit tests (label humanization, importance
 * heuristic, type inference, choices, FK reference) and the rendered metadata
 * shape (primaryFields / searchFields / defaultSort / capabilities / timestamps
 * rows / belongs_to relation rows).
 */

import { describe, expect, it } from 'bun:test';
import {
	deriveFieldMeta,
	formatLabel,
	inferUiImportance,
	inferUiType,
	isEntityRefField,
} from '../../../emitters/frontend/field-meta';
import {
	buildFieldMetaTypeFile,
	buildEntityFieldsFile,
} from '../../../emitters/frontend/emit-fields';
import {
	ctx,
	entry,
	field,
	parsedEntity,
	parsedMap,
	relationship,
} from './_helpers';

describe('field-meta — label humanization', () => {
	it('humanizes snake_case names', () => {
		expect(formatLabel('first_name')).toBe('First Name');
		expect(formatLabel('deal_state')).toBe('Deal State');
	});

	it('explicit ui.label wins', () => {
		const meta = deriveFieldMeta(field('amount', { ui: { label: 'Total $' } }));
		expect(meta.label).toBe('Total $');
	});
});

describe('field-meta — importance heuristic', () => {
	it('id and timestamps are tertiary', () => {
		expect(inferUiImportance(field('id'))).toBe('tertiary');
		expect(inferUiImportance(field('created_at'))).toBe('tertiary');
	});

	it('name/title are primary; required fields are primary', () => {
		expect(inferUiImportance(field('name'))).toBe('primary');
		expect(inferUiImportance(field('title'))).toBe('primary');
		expect(inferUiImportance(field('quantity', { required: true }))).toBe('primary');
	});

	it('FK *_id is secondary; explicit ui.importance wins', () => {
		expect(
			inferUiImportance(
				field('account_id', { foreignKey: { table: 'accounts', column: 'id' } }),
			),
		).toBe('secondary');
		expect(inferUiImportance(field('name', { ui: { importance: 'tertiary' } }))).toBe(
			'tertiary',
		);
	});
});

describe('field-meta — type inference', () => {
	it('choices ⇒ enum, FK ⇒ reference', () => {
		expect(inferUiType(field('status', { choices: ['a', 'b'] }))).toBe('enum');
		expect(
			inferUiType(field('account_id', { foreignKey: { table: 'accounts', column: 'id' } })),
		).toBe('reference');
	});

	it('name-pattern heuristics: email / url / money', () => {
		expect(inferUiType(field('contact_email'))).toBe('email');
		expect(inferUiType(field('website'))).toBe('url');
		expect(inferUiType(field('total_amount'))).toBe('money');
	});

	it('base type map: long string ⇒ textarea, boolean, datetime', () => {
		expect(inferUiType(field('bio', { type: 'string', constraints: { maxLength: 1000 } }))).toBe(
			'textarea',
		);
		expect(inferUiType(field('active', { type: 'boolean' }))).toBe('boolean');
		expect(inferUiType(field('seen_at', { type: 'datetime' }))).toBe('datetime');
	});
});

describe('field-meta — choices + reference passthrough', () => {
	it('emits choices array and FK reference table', () => {
		const meta = deriveFieldMeta(field('status', { choices: ['open', 'closed'] }));
		expect(meta.choices).toEqual(['open', 'closed']);

		const fk = deriveFieldMeta(
			field('account_id', { foreignKey: { table: 'accounts', column: 'id' } }),
		);
		expect(fk.reference).toBe('accounts');
	});
});

describe('field-meta — entity_ref skip', () => {
	it('skips entity_ref base + derived _entity_type/_entity_id columns', () => {
		expect(isEntityRefField(field('subject', { type: 'entity_ref' }))).toBe(true);
		expect(isEntityRefField(field('subject_entity_type'))).toBe(true);
		expect(isEntityRefField(field('subject_entity_id'))).toBe(true);
		expect(isEntityRefField(field('name'))).toBe(false);
	});
});

describe('emit-fields — type file', () => {
	it('emits self-contained FieldMeta/FieldType/FieldImportance (no external import)', () => {
		const out = buildFieldMetaTypeFile();
		expect(out).toContain('export interface FieldMeta<T = unknown> {');
		expect(out).toContain('export type FieldType =');
		expect(out).toContain("export type FieldImportance = 'primary' | 'secondary' | 'tertiary';");
		expect(out).not.toContain('frontendFieldMetaTypes');
		expect(out).not.toContain('import ');
	});
});

describe('emit-fields — entity metadata file', () => {
	function dealCtx() {
		const deal = entry('deal', 'deals');
		const account = entry('account', 'accounts');
		const parsed = parsedMap(
			parsedEntity(account),
			parsedEntity(deal, {
				behaviors: ['timestamps'],
				fields: new Map([
					['name', field('name', { required: true })],
					['status', field('status', { choices: ['open', 'won'], ui: { filterable: true } })],
					['amount', field('amount', { type: 'decimal' })],
					['account_id', field('account_id', { foreignKey: { table: 'accounts', column: 'id' } })],
					['id', field('id')], // must be skipped
				]),
				relationships: new Map([
					['account', relationship('account', { target: 'account', foreignKey: 'account_id' })],
				]),
			}),
		);
		return { deal, c: ctx([account, deal], {}, parsed) };
	}

	it('renders the FieldMeta map; skips id; primary/search/sort derived', () => {
		const { deal, c } = dealCtx();
		const out = buildEntityFieldsFile(deal, c);

		expect(out).toContain('export const dealFields: Record<string, FieldMeta<Deal>>');
		// id is skipped from the metadata map keys.
		expect(out).not.toContain('\tid: {');
		// name → primary
		expect(out).toContain("importance: 'primary' as FieldImportance,");
		// status → enum + choices + filterable
		expect(out).toContain('choices: ["open","won"],');
		expect(out).toContain('filterable: true,');
		// FK reference table
		expect(out).toContain("reference: 'accounts',");
		// primaryFields + searchFields
		expect(out).toContain("'name',");
		// defaultSort uses createdAt because timestamps behavior present
		expect(out).toContain("defaultSort: { field: 'createdAt', direction: 'desc' as const }");
	});

	it('emits belongs_to relation row with registry plural reference', () => {
		const { deal, c } = dealCtx();
		const out = buildEntityFieldsFile(deal, c);
		expect(out).toContain('account: {');
		expect(out).toContain("type: 'entity' as FieldType,");
		expect(out).toContain("reference: 'accounts',");
	});

	it('emits createdAt/updatedAt rows when timestamps behavior is set', () => {
		const { deal, c } = dealCtx();
		const out = buildEntityFieldsFile(deal, c);
		expect(out).toContain('createdAt: {');
		expect(out).toContain('updatedAt: {');
		expect(out).toContain("format: { dateFormat: 'relative' },");
	});

	it('defaultSort falls back to id when no timestamps', () => {
		const plain = entry('tag', 'tags');
		const c = ctx([plain], {}, parsedMap(parsedEntity(plain)));
		const out = buildEntityFieldsFile(plain, c);
		expect(out).toContain("defaultSort: { field: 'id', direction: 'desc' as const }");
	});

	it('capabilities gate write on repository|trpc exposure (default-on)', () => {
		const e = entry('thing', 'things');

		// default expose → repository present → writable
		const onCtx = ctx([e], {}, parsedMap(parsedEntity(e)));
		const onOut = buildEntityFieldsFile(e, onCtx);
		expect(onOut).toContain('create: true,');
		expect(onOut).toContain('update: true,');
		expect(onOut).toContain('delete: true,');

		// expose: ['rest'] only → no repository, no trpc → not writable
		const offCtx = ctx([e], {}, parsedMap(parsedEntity(e, { expose: ['rest'] })));
		const offOut = buildEntityFieldsFile(e, offCtx);
		expect(offOut).toContain('create: false,');
		expect(offOut).toContain('update: false,');
		expect(offOut).toContain('delete: false,');
		// read is never gated.
		expect(offOut).toContain('list: true,');
		expect(offOut).toContain('get: true,');
	});
});
