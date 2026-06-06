/**
 * Frontend emitter — field metadata tests (ADR-038, FE-3; enriched per ADR-040).
 *
 * Two layers: pure UI-derivation unit tests (label humanization, importance
 * heuristic, type inference, choices, FK reference, ui-hint passthrough,
 * key-field curation, external-sync defaults, the EAV contract) and the
 * rendered metadata shape (primaryFields / keyFields / searchFields /
 * defaultSort / capabilities / timestamps + soft_delete rows / belongs_to
 * relation rows).
 *
 * Also covers `frontend.fields.textareaThreshold` inference knob (§3–4 of
 * the textarea-threshold spec) — default, custom, null-disables, ui_type wins,
 * and the ctx→displayFields threading proof.
 */

import { describe, expect, it } from 'bun:test';
import {
	DEFAULT_TEXTAREA_THRESHOLD,
	deriveFieldMeta,
	formatLabel,
	hasExternalSyncShape,
	inferUiImportance,
	inferUiType,
	isEntityRefField,
	EAV_DATA_TYPE_TO_FIELD_TYPE,
	type FieldType,
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

describe('field-meta — ui hint passthrough (ADR-040)', () => {
	it('passes group / visible / placeholder / help / format through verbatim', () => {
		const meta = deriveFieldMeta(
			field('email', {
				ui: {
					group: 'contact',
					visible: false,
					placeholder: 'name@example.com',
					help: 'Primary contact address.',
					format: { mask: 'lowercase' },
				},
			}),
		);
		expect(meta.group).toBe('contact');
		expect(meta.visible).toBe(false);
		expect(meta.placeholder).toBe('name@example.com');
		expect(meta.help).toBe('Primary contact address.');
		expect(meta.format).toEqual({ mask: 'lowercase' });
	});

	it('omits the keys entirely when unset (no undefined noise)', () => {
		const meta = deriveFieldMeta(field('email'));
		expect('group' in meta).toBe(false);
		expect('visible' in meta).toBe(false);
		expect('placeholder' in meta).toBe(false);
		expect('help' in meta).toBe(false);
		expect('format' in meta).toBe(false);
	});

	it('defaults.group fills only where the author left ui_group unset', () => {
		const defaulted = deriveFieldMeta(field('external_id'), { group: 'external_sync' });
		expect(defaulted.group).toBe('external_sync');

		const authored = deriveFieldMeta(
			field('external_id', { ui: { group: 'integrations' } }),
			{ group: 'external_sync' },
		);
		expect(authored.group).toBe('integrations');
	});
});

describe('field-meta — key-field curation (ADR-040)', () => {
	it('ui_key_field surfaces as isKeyField + keyFieldOrder', () => {
		const meta = deriveFieldMeta(
			field('email', { ui: { keyField: true, keyFieldOrder: 2 } }),
		);
		expect(meta.isKeyField).toBe(true);
		expect(meta.keyFieldOrder).toBe(2);
	});

	it('keyFieldOrder without keyField is dropped; non-key fields stay bare', () => {
		const orphanOrder = deriveFieldMeta(field('email', { ui: { keyFieldOrder: 3 } }));
		expect('isKeyField' in orphanOrder).toBe(false);
		expect('keyFieldOrder' in orphanOrder).toBe(false);

		const plain = deriveFieldMeta(field('email'));
		expect('isKeyField' in plain).toBe(false);
	});
});

describe('field-meta — external-sync shape detection (ADR-040)', () => {
	it('requires BOTH external_id and provider', () => {
		expect(hasExternalSyncShape(['external_id', 'provider', 'name'])).toBe(true);
		expect(hasExternalSyncShape(['external_id', 'name'])).toBe(false);
		expect(hasExternalSyncShape(['provider', 'name'])).toBe(false);
		expect(hasExternalSyncShape([])).toBe(false);
	});
});

describe('field-meta — EAV data_type → FieldType contract (ADR-040)', () => {
	it('covers the full EAV data_type vocabulary', () => {
		expect(Object.keys(EAV_DATA_TYPE_TO_FIELD_TYPE).sort()).toEqual(
			[
				'boolean',
				'date',
				'datetime',
				'decimal',
				'integer',
				'json',
				'multipicklist',
				'picklist',
				'reference',
				'string',
			].sort(),
		);
	});

	it('maps both picklist and multipicklist to enum (multi-select is consumer-side)', () => {
		expect(EAV_DATA_TYPE_TO_FIELD_TYPE.picklist).toBe('enum');
		expect(EAV_DATA_TYPE_TO_FIELD_TYPE.multipicklist).toBe('enum');
	});

	it('every value is a member of the FieldType union', () => {
		const fieldTypes: FieldType[] = [
			'text', 'textarea', 'number', 'boolean', 'date', 'datetime', 'email',
			'url', 'password', 'money', 'percentage', 'json', 'enum', 'reference',
			'entity',
		];
		for (const v of Object.values(EAV_DATA_TYPE_TO_FIELD_TYPE)) {
			expect(fieldTypes).toContain(v);
		}
	});
});

describe('emit-fields — type file (ADR-040 additions)', () => {
	it('declares the enriched optional surface on FieldMeta', () => {
		const out = buildFieldMetaTypeFile();
		expect(out).toContain('group?: string;');
		expect(out).toContain('visible?: boolean;');
		expect(out).toContain('placeholder?: string;');
		expect(out).toContain('help?: string;');
		expect(out).toContain('isKeyField?: boolean;');
		expect(out).toContain('keyFieldOrder?: number;');
	});

	it('emits the EAV contract rendered from the source constant (no drift)', () => {
		const out = buildFieldMetaTypeFile();
		expect(out).toContain('export type EavDataType =');
		expect(out).toContain(
			'export const EAV_DATA_TYPE_TO_FIELD_TYPE: Record<EavDataType, FieldType> = {',
		);
		for (const [k, v] of Object.entries(EAV_DATA_TYPE_TO_FIELD_TYPE)) {
			expect(out).toContain(`\t${k}: '${v}',`);
			expect(out).toContain(`| '${k}'`);
		}
	});
});

describe('emit-fields — ui hints + key fields in the rendered file (ADR-040)', () => {
	function curatedCtx() {
		const contact = entry('contact', 'contacts');
		const parsed = parsedMap(
			parsedEntity(contact, {
				fields: new Map([
					// email declared FIRST but ordered second — locks the sort.
					['email', field('email', { ui: { keyField: true, keyFieldOrder: 1, placeholder: "name@example.com", help: "The contact's address." } })],
					['name', field('name', { required: true, ui: { keyField: true, keyFieldOrder: 0 } })],
					['notes', field('notes', { ui: { group: 'detail', visible: false, format: { rows: 4 } } })],
				]),
			}),
		);
		return { contact, c: ctx([contact], {}, parsed) };
	}

	it('renders the hint keys and escapes quotes in strings', () => {
		const { contact, c } = curatedCtx();
		const out = buildEntityFieldsFile(contact, c);
		expect(out).toContain("placeholder: 'name@example.com',");
		expect(out).toContain("help: 'The contact\\'s address.',");
		expect(out).toContain("group: 'detail',");
		expect(out).toContain('visible: false,');
		expect(out).toContain('format: {"rows":4},');
	});

	it('renders isKeyField/keyFieldOrder rows and the ordered keyFields list', () => {
		const { contact, c } = curatedCtx();
		const out = buildEntityFieldsFile(contact, c);
		expect(out).toContain('isKeyField: true,');
		expect(out).toContain('keyFieldOrder: 0,');
		// keyFields sorted by keyFieldOrder: name (0) before email (1) despite
		// email being declared first.
		expect(out).toContain("keyFields: [\n\t\t'name',\n\t\t'email',\n\t],");
	});

	it('emits an empty keyFields list when nothing is curated', () => {
		const plain = entry('tag', 'tags');
		const c = ctx([plain], {}, parsedMap(parsedEntity(plain)));
		const out = buildEntityFieldsFile(plain, c);
		expect(out).toContain('keyFields: [\n\n\t],');
	});
});

describe('emit-fields — behavior/family bundles (ADR-040)', () => {
	it('soft_delete behavior contributes a deletedAt row (datetime/tertiary/relative)', () => {
		const e = entry('doc', 'docs');
		const c = ctx([e], {}, parsedMap(parsedEntity(e, { behaviors: ['soft_delete'] })));
		const out = buildEntityFieldsFile(e, c);
		expect(out).toContain('deletedAt: {');
		expect(out).toContain("field: 'deletedAt',");
		expect(out).toContain("label: 'Deleted',");
		expect(out).toContain("format: { dateFormat: 'relative' },");
	});

	it('no deletedAt row without the behavior', () => {
		const e = entry('doc', 'docs');
		const c = ctx([e], {}, parsedMap(parsedEntity(e)));
		expect(buildEntityFieldsFile(e, c)).not.toContain('deletedAt: {');
	});

	it('external_id+provider(+provider_metadata) default to group external_sync', () => {
		const e = entry('deal', 'deals');
		const c = ctx(
			[e],
			{},
			parsedMap(
				parsedEntity(e, {
					fields: new Map([
						['name', field('name', { required: true })],
						['external_id', field('external_id', { nullable: true })],
						['provider', field('provider', { nullable: true })],
						['provider_metadata', field('provider_metadata', { type: 'json', nullable: true })],
					]),
				}),
			),
		);
		const out = buildEntityFieldsFile(e, c);
		const matches = out.match(/group: 'external_sync',/g) ?? [];
		expect(matches.length).toBe(3);
		// the non-bookkeeping field is untouched
		expect(out).not.toMatch(/name: \{[^}]*group:/);
	});

	it('authored ui_group beats the external_sync default; no gate ⇒ no default', () => {
		const e = entry('deal', 'deals');
		const authored = ctx(
			[e],
			{},
			parsedMap(
				parsedEntity(e, {
					fields: new Map([
						['external_id', field('external_id', { ui: { group: 'integrations' } })],
						['provider', field('provider')],
					]),
				}),
			),
		);
		const authoredOut = buildEntityFieldsFile(e, authored);
		expect(authoredOut).toContain("group: 'integrations',");
		expect(authoredOut).toContain("group: 'external_sync',"); // provider still defaulted

		// provider alone (no external_id) ⇒ shape gate fails ⇒ no default.
		const ungated = ctx(
			[e],
			{},
			parsedMap(
				parsedEntity(e, {
					fields: new Map([['provider', field('provider')]]),
				}),
			),
		);
		expect(buildEntityFieldsFile(e, ungated)).not.toContain('external_sync');
	});
});

// ============================================================================
// Spec: frontend.fields.textareaThreshold
// ============================================================================

describe('field-meta — DEFAULT_TEXTAREA_THRESHOLD constant', () => {
	it('equals 500', () => {
		expect(DEFAULT_TEXTAREA_THRESHOLD).toBe(500);
	});
});

describe('field-meta — inferUiType textarea threshold (default 500)', () => {
	it('default: maxLength 1000 → textarea (existing behavior preserved)', () => {
		expect(inferUiType(field('bio', { type: 'string', constraints: { maxLength: 1000 } }))).toBe(
			'textarea',
		);
	});

	it('default: maxLength === 500 → text (strict > boundary)', () => {
		expect(inferUiType(field('bio', { type: 'string', constraints: { maxLength: 500 } }))).toBe(
			'text',
		);
	});

	it('default: maxLength 501 → textarea', () => {
		expect(inferUiType(field('bio', { type: 'string', constraints: { maxLength: 501 } }))).toBe(
			'textarea',
		);
	});

	it('default: no maxLength → text (unbounded short-circuit)', () => {
		expect(inferUiType(field('bio', { type: 'string' }))).toBe('text');
	});

	it('custom threshold: maxLength 150 with threshold 100 → textarea', () => {
		expect(
			inferUiType(field('bio', { type: 'string', constraints: { maxLength: 150 } }), {
				textareaThreshold: 100,
			}),
		).toBe('textarea');
	});

	it('custom threshold: maxLength === 100 → text (strict >)', () => {
		expect(
			inferUiType(field('bio', { type: 'string', constraints: { maxLength: 100 } }), {
				textareaThreshold: 100,
			}),
		).toBe('text');
	});

	it('null threshold disables: maxLength 10000 → text', () => {
		expect(
			inferUiType(field('bio', { type: 'string', constraints: { maxLength: 10000 } }), {
				textareaThreshold: null,
			}),
		).toBe('text');
	});

	it('explicit ui_type wins over custom threshold (rung 1 of the ladder)', () => {
		expect(
			inferUiType(
				field('bio', { type: 'string', constraints: { maxLength: 10 }, ui: { type: 'textarea' } }),
				{ textareaThreshold: 100 },
			),
		).toBe('textarea');
		expect(
			inferUiType(
				field('bio', { type: 'string', constraints: { maxLength: 10000 }, ui: { type: 'text' } }),
				{ textareaThreshold: null },
			),
		).toBe('text');
	});
});

describe('field-meta — deriveFieldMeta threads opts through to inferUiType', () => {
	it('null threshold: maxLength 10000 → type: text', () => {
		const meta = deriveFieldMeta(
			field('notes', { type: 'string', constraints: { maxLength: 10000 } }),
			{},
			{ textareaThreshold: null },
		);
		expect(meta.type).toBe('text');
	});

	it('custom threshold 100: maxLength 150 → type: textarea', () => {
		const meta = deriveFieldMeta(
			field('notes', { type: 'string', constraints: { maxLength: 150 } }),
			{},
			{ textareaThreshold: 100 },
		);
		expect(meta.type).toBe('textarea');
	});
});

describe('emit-fields — textareaThreshold threading proof (ctx → displayFields)', () => {
	function thresholdEntity(maxLength: number) {
		const e = entry('note', 'notes');
		const parsed = parsedMap(
			parsedEntity(e, {
				fields: new Map([
					['body', field('body', { type: 'string', constraints: { maxLength } })],
				]),
			}),
		);
		return { e, parsed };
	}

	it('null threshold in ctx.config ⇒ type: text even for very long string', () => {
		const { e, parsed } = thresholdEntity(10000);
		const c = ctx([e], { textareaThreshold: null }, parsed);
		const out = buildEntityFieldsFile(e, c);
		expect(out).toContain("type: 'text' as FieldType,");
		expect(out).not.toContain("type: 'textarea'");
	});

	it('custom threshold 100 in ctx.config ⇒ maxLength 150 renders as textarea', () => {
		const { e, parsed } = thresholdEntity(150);
		const c = ctx([e], { textareaThreshold: 100 }, parsed);
		const out = buildEntityFieldsFile(e, c);
		expect(out).toContain("type: 'textarea' as FieldType,");
	});

	it('default threshold 500 in ctx.config ⇒ maxLength 501 renders as textarea', () => {
		const { e, parsed } = thresholdEntity(501);
		const c = ctx([e], { textareaThreshold: 500 }, parsed);
		const out = buildEntityFieldsFile(e, c);
		expect(out).toContain("type: 'textarea' as FieldType,");
	});

	it('default threshold 500 in ctx.config ⇒ maxLength 500 renders as text (strict >)', () => {
		const { e, parsed } = thresholdEntity(500);
		const c = ctx([e], { textareaThreshold: 500 }, parsed);
		const out = buildEntityFieldsFile(e, c);
		expect(out).toContain("type: 'text' as FieldType,");
		expect(out).not.toContain("type: 'textarea'");
	});
});
