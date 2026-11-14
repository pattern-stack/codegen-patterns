/**
 * The link pass's delegate rules (ADR-046, PLAN §4.3 step 2, §14.4 F7, decision D4).
 *
 * Every `delegatesTo` must resolve to a method the target's surface lists, emitted or inherited; and a
 * `relation_many` must reach an FK finder. Each case is one the pre-flights ran through `entity new` + `tsc`
 * (`.ai-docs/stacks/api-surface-model/{f7,d4}-preflight/`): every warning here is a project whose generated
 * service does not compile, and every control compiles. A warning, not an error (Q5).
 */

import { describe, expect, it } from 'bun:test';

import type { EntityDefinitionInput } from '../../derived/api/entity';
import { deriveProjectFromSet } from './_project';

const def = (d: Record<string, unknown>): EntityDefinitionInput => d as unknown as EntityDefinitionInput;

// ── F7: account has_many contacts (foreign_key: account_id) ─────────────────
const account = def({
	entity: { name: 'account', plural: 'accounts' },
	fields: { name: { type: 'string', required: true } },
	behaviors: ['timestamps'],
	relationships: { contacts: { type: 'has_many', target: 'contact', foreign_key: 'account_id' } },
});

const contact = (tail: Record<string, unknown>) =>
	def({
		entity: { name: 'contact', plural: 'contacts' },
		fields: {
			account_id: { type: 'uuid', required: true, index: true, foreign_key: 'accounts.id' },
			email: { type: 'string', required: true },
		},
		behaviors: ['timestamps'],
		...tail,
	});

const belongsToAccount = { account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } };

const f7 = (c: EntityDefinitionInput) => deriveProjectFromSet({ entities: [account, c], junctions: [] }).warnings;

const NOT_EMITTED =
	'account.relationships.contacts: `AccountService.contacts` calls `ContactRepository.findByAccountId`, which contact does not emit';
const NOT_FK_FINDER =
	'account.relationships.contacts: `AccountService.contacts` calls `ContactRepository.findByAccountId`, which is a `queries:` finder, not an FK finder';

describe('F7 — a relation_many reaches an FK finder', () => {
	it('V0 (control): contact belongs_to account — no warning', () => {
		expect(f7(contact({ relationships: belongsToAccount }))).toEqual([]);
	});

	it('V1: account_id is a plain field — the delegate does not exist', () => {
		expect(f7(contact({}))).toEqual([NOT_EMITTED]);
	});

	it('V2: a plain `queries: by [account_id]` finder takes the name — wrong kind', () => {
		expect(f7(contact({ queries: [{ by: ['account_id'] }] }))).toEqual([NOT_FK_FINDER]);
	});

	it('V3: belongs_to + a unique `queries: by [account_id]` — the unique finder wins the name, wrong kind', () => {
		expect(f7(contact({ relationships: belongsToAccount, queries: [{ by: ['account_id'], unique: true }] }))).toEqual([
			NOT_FK_FINDER,
		]);
	});
});

// ── D4: an EAV value table whose pattern does not supply findByEntityIdAndType ──
const fieldDefinition = def({
	entity: { name: 'field_definition', plural: 'field_definitions' },
	fields: {
		entity_type: { type: 'string', required: true },
		key: { type: 'string', required: true },
	},
	behaviors: ['timestamps'],
});

const fieldValue = (pattern: string | undefined) =>
	def({
		entity: { name: 'field_value', plural: 'field_values', ...(pattern ? { pattern } : {}) },
		eav_value_table: true,
		eav_definition_table: 'field_definition',
		fields: {
			entity_type: { type: 'string', required: true },
			entity_id: { type: 'uuid', required: true },
			field_definition_id: { type: 'uuid', required: true },
			user_id: { type: 'uuid', required: true },
			value: { type: 'json', required: true },
		},
		behaviors: ['timestamps'],
	});

const d4 = (pattern: string | undefined) =>
	deriveProjectFromSet({ entities: [fieldValue(pattern), fieldDefinition], junctions: [] }).warnings;

const D4_WARNING =
	'field_value.eav_value_table: `FieldValueService.findMergedByEntity` calls `FieldValueRepository.findByEntityIdAndType`, which field_value does not emit';

describe('D4 — every delegate resolves on its target, emitted or inherited', () => {
	it('W0 (control): pattern Metadata — the inherited findByEntityIdAndType resolves it', () => {
		expect(d4('Metadata')).toEqual([]);
	});

	it('W1: no pattern (Base) — exactly the one warning', () => {
		expect(d4(undefined)).toEqual([D4_WARNING]);
	});

	it('W2: pattern Integrated — exactly the one warning', () => {
		expect(d4('Integrated')).toEqual([D4_WARNING]);
	});
});
