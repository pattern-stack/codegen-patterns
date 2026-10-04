/**
 * The one field-nullability rule (#613, #736) — every declaration combination,
 * and the schema facts the rule leans on.
 */

import { describe, it, expect } from 'bun:test';
import {
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

describe('foreignKeyColumnNullable', () => {
	it('an explicit relationship nullable wins over the field, both ways', () => {
		expect(foreignKeyColumnNullable(true, { required: true })).toBe(true);
		expect(foreignKeyColumnNullable(false, { nullable: true })).toBe(false);
	});

	it('no relationship nullable → the field decides', () => {
		expect(foreignKeyColumnNullable(undefined, { required: true })).toBe(false);
		expect(foreignKeyColumnNullable(undefined, { nullable: false, default: 'x' })).toBe(false);
		expect(foreignKeyColumnNullable(undefined, {})).toBe(true);
		expect(foreignKeyColumnNullable(null, { required: true })).toBe(false);
	});

	it('no relationship nullable and no field declaration → nullable', () => {
		expect(foreignKeyColumnNullable(undefined, undefined)).toBe(true);
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
			entity: { name: 'stat_line', plural: 'stat_lines', table: 'stat_lines' },
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
			entity: { name: 'stat_line', plural: 'stat_lines', table: 'stat_lines' },
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
