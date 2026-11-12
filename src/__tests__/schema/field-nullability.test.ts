/**
 * The one field-nullability rule (#613, #736) — every declaration combination,
 * and the schema facts the rule leans on.
 */

import { describe, it, expect } from 'bun:test';
import {
	FK_REQUIRED_FALSE_MESSAGE,
	NOT_NULL_WITHOUT_DEFAULT_MESSAGE,
	fieldColumnNullable,
	foreignKeyColumnNullable,
	hasColumnDefault,
	notNullWithoutDefault,
} from '../../schema/field-nullability';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';

describe('fieldColumnNullable', () => {
	it('neither declared → nullable', () => {
		expect(fieldColumnNullable({})).toBe(true);
	});

	it('required: true → NOT NULL', () => {
		expect(fieldColumnNullable({ required: true })).toBe(false);
	});

	it('required: false, nullable undeclared → nullable', () => {
		expect(fieldColumnNullable({ required: false })).toBe(true);
	});

	it('required: false, nullable: true → nullable', () => {
		expect(fieldColumnNullable({ required: false, nullable: true })).toBe(true);
	});

	it('required: false, nullable: false (+ default) → NOT NULL (#736)', () => {
		expect(fieldColumnNullable({ required: false, nullable: false, default: 0 })).toBe(false);
	});

	it('required: true, nullable: false → NOT NULL', () => {
		expect(fieldColumnNullable({ required: true, nullable: false })).toBe(false);
	});

	it('nullable: false alone → NOT NULL (the schema then demands a default)', () => {
		expect(fieldColumnNullable({ nullable: false })).toBe(false);
	});
});

describe('foreignKeyColumnNullable — a reference is NOT NULL unless it says otherwise (#850)', () => {
	it('an explicit relationship nullable wins over the field, both ways', () => {
		expect(foreignKeyColumnNullable(true, { required: true })).toBe(true);
		expect(foreignKeyColumnNullable(false, { nullable: true })).toBe(false);
	});

	it("no relationship nullable → the field's nullable decides", () => {
		expect(foreignKeyColumnNullable(undefined, { nullable: true })).toBe(true);
		expect(foreignKeyColumnNullable(undefined, { nullable: false, default: 'x' })).toBe(false);
		expect(foreignKeyColumnNullable(null, { nullable: true })).toBe(true);
	});

	it('required: does not decide it — undeclared, the FK is NOT NULL', () => {
		expect(foreignKeyColumnNullable(undefined, {})).toBe(false);
		expect(foreignKeyColumnNullable(undefined, { required: true })).toBe(false);
		expect(foreignKeyColumnNullable(undefined, { required: false })).toBe(false);
		expect(foreignKeyColumnNullable(undefined, undefined)).toBe(false);
	});
});

describe('EntityDefinitionSchema — `required: false` on a belongs_to FK (#850)', () => {
	const entity = (fk: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
		entity: { name: 'deal', plural: 'deals' },
		fields: { account_id: { type: 'uuid', ...fk } },
		relationships: { account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } },
		...extra,
	});
	const fkIssue = (data: unknown) =>
		EntityDefinitionSchema.safeParse(data).error?.issues.find(
			(i) => i.message === FK_REQUIRED_FALSE_MESSAGE,
		);

	it('rejects a written required: false without nullable:, pointing at nullable: true', () => {
		expect(fkIssue(entity({ required: false }))?.path).toEqual(['fields', 'account_id', 'required']);
		expect(FK_REQUIRED_FALSE_MESSAGE).toContain("'nullable: true'");
	});

	it('rejects it on a cardinality: one role FK too', () => {
		const data = {
			entity: { name: 'meeting', plural: 'meetings' },
			capabilities: ['Communication'],
			fields: { host_contact_id: { type: 'uuid', required: false } },
			roles: { host: { target: 'contact', cardinality: 'one' } },
		};
		expect(fkIssue(data)?.path).toEqual(['fields', 'host_contact_id', 'required']);
	});

	it('accepts required: false with nullable:, an undeclared required:, and a non-FK field', () => {
		expect(fkIssue(entity({ required: false, nullable: true }))).toBeUndefined();
		expect(fkIssue(entity({}))).toBeUndefined();
		expect(fkIssue(entity({ nullable: true }))).toBeUndefined();
		expect(
			fkIssue({ entity: { name: 'deal', plural: 'deals' }, fields: { note: { type: 'string', required: false } } }),
		).toBeUndefined();
	});

	it('an absent required: stays undefined after parsing, so the two are distinguishable', () => {
		const parsed = EntityDefinitionSchema.parse(entity({}));
		expect(parsed.fields.account_id.required).toBeUndefined();
	});
});

describe('notNullWithoutDefault', () => {
	it('flags nullable: false without required: true and without a default', () => {
		expect(notNullWithoutDefault({ nullable: false })).toBe(true);
		expect(notNullWithoutDefault({ required: false, nullable: false })).toBe(true);
		expect(notNullWithoutDefault({ nullable: false, default: null })).toBe(true);
	});

	it('accepts the other declarations', () => {
		expect(notNullWithoutDefault({})).toBe(false);
		expect(notNullWithoutDefault({ required: true })).toBe(false);
		expect(notNullWithoutDefault({ required: true, nullable: false })).toBe(false);
		expect(notNullWithoutDefault({ nullable: true })).toBe(false);
		expect(notNullWithoutDefault({ nullable: false, default: 0 })).toBe(false);
		expect(notNullWithoutDefault({ nullable: false, default: false })).toBe(false);
	});

	it('a falsy default is still a default; null is not', () => {
		expect(hasColumnDefault({ default: 0 })).toBe(true);
		expect(hasColumnDefault({ default: '' })).toBe(true);
		expect(hasColumnDefault({ default: null })).toBe(false);
		expect(hasColumnDefault({})).toBe(false);
	});
});

describe('FieldDefinitionSchema — what the rule leans on', () => {
	const parse = (field: Record<string, unknown>) =>
		EntityDefinitionSchema.parse({
			entity: { name: 'stat_line', plural: 'stat_lines' },
			fields: { pts: { type: 'integer', ...field } },
		}).fields.pts;

	it('an undeclared nullable stays undeclared after parsing', () => {
		expect(parse({}).nullable).toBeUndefined();
		expect(fieldColumnNullable(parse({}))).toBe(true);
	});

	it('an explicit nullable: false survives parsing and reads NOT NULL', () => {
		const pts = parse({ required: false, nullable: false, default: 0 });
		expect(pts.nullable).toBe(false);
		expect(fieldColumnNullable(pts)).toBe(false);
	});

	it('rejects nullable: false without required: true and without a default', () => {
		const result = EntityDefinitionSchema.safeParse({
			entity: { name: 'stat_line', plural: 'stat_lines' },
			fields: { pts: { type: 'integer', required: false, nullable: false } },
		});
		expect(result.success).toBe(false);
		const issue = result.error?.issues.find((i) => i.message === NOT_NULL_WITHOUT_DEFAULT_MESSAGE);
		expect(issue?.path).toEqual(['fields', 'pts', 'nullable']);
	});

	it('still rejects required: true with nullable: true', () => {
		expect(() => parse({ required: true, nullable: true })).toThrow(/cannot both be set/);
	});
});
