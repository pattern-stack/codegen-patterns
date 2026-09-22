/**
 * CAP-2 — the `roles:` block at the schema boundary.
 *
 * Every rule here is a load-time rejection: the shape is wrong before any
 * other entity or registry is consulted.
 */

import { describe, test, expect } from 'bun:test';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema.ts';

const base = {
	entity: { name: 'meeting', plural: 'meetings', table: 'meetings' },
	fields: { title: { type: 'string', required: true } },
};

function parse(extra: Record<string, unknown>) {
	return EntityDefinitionSchema.safeParse({ ...base, ...extra });
}

function messages(extra: Record<string, unknown>): string[] {
	const r = parse(extra);
	return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('roles: — accepted shapes', () => {
	test('PLAN §6.3 block parses as written', () => {
		const r = parse({
			roles: {
				host: { target: 'contact', cardinality: 'one', column: 'host_contact_id' },
				attendees: { target: 'contact', cardinality: 'many', via: 'meeting_contact' },
				about: { target: 'account', cardinality: 'one' },
			},
		});
		expect(r.success).toBe(true);
	});

	test('a one-role may set nullable and on_delete', () => {
		const r = parse({
			roles: {
				about: { target: 'account', cardinality: 'one', nullable: true, on_delete: 'set_null' },
			},
		});
		expect(r.success).toBe(true);
	});

	test('roles: is optional — an entity without it is unchanged', () => {
		expect(parse({}).success).toBe(true);
	});
});

describe('roles: — rejected shapes', () => {
	test('a many-role without via: is rejected with the reason', () => {
		const m = messages({ roles: { attendees: { target: 'contact', cardinality: 'many' } } });
		expect(m.some((x) => x.startsWith('roles.attendees.via') && x.includes("must declare 'via:'"))).toBe(true);
	});

	test('via: on a one-role is rejected', () => {
		const m = messages({
			roles: { host: { target: 'contact', cardinality: 'one', via: 'meeting_contact' } },
		});
		expect(m.some((x) => x.startsWith('roles.host.via'))).toBe(true);
	});

	test.each(['column', 'nullable', 'on_delete'] as const)(
		'%s on a many-role is rejected — the junction owns its columns',
		(key) => {
			const value = key === 'column' ? 'x_id' : key === 'nullable' ? true : 'cascade';
			const m = messages({
				roles: {
					attendees: { target: 'contact', cardinality: 'many', via: 'meeting_contact', [key]: value },
				},
			});
			expect(m.some((x) => x.startsWith(`roles.attendees.${key}`))).toBe(true);
		},
	);

	test('an unknown key is rejected (.strict)', () => {
		const m = messages({ roles: { host: { target: 'contact', cardinality: 'one', alias: 'h' } } });
		expect(m.length).toBeGreaterThan(0);
	});

	test('an unknown cardinality is rejected', () => {
		expect(parse({ roles: { host: { target: 'contact', cardinality: 'some' } } }).success).toBe(false);
	});

	test('a non-snake_case role name is rejected', () => {
		expect(parse({ roles: { Host: { target: 'contact', cardinality: 'one' } } }).success).toBe(false);
	});

	test('the derived belongs_to is validated by RelationshipSchema — set_null needs nullable', () => {
		const m = messages({
			roles: { about: { target: 'account', cardinality: 'one', on_delete: 'set_null' } },
		});
		expect(m.some((x) => x.includes("derives an invalid belongs_to") && x.includes('set_null'))).toBe(true);
	});

	test('a role sharing a name with a declared relationship is rejected', () => {
		const m = messages({
			relationships: { host: { type: 'belongs_to', target: 'contact', foreign_key: 'contact_id' } },
			roles: { host: { target: 'contact', cardinality: 'one' } },
		});
		expect(m.some((x) => x.startsWith('roles.host') && x.includes('collides with the relationship'))).toBe(true);
	});

	test('a role whose derived FK is already a relationship FK is rejected', () => {
		const m = messages({
			relationships: {
				organizer: { type: 'belongs_to', target: 'contact', foreign_key: 'host_contact_id' },
			},
			roles: { host: { target: 'contact', cardinality: 'one' } },
		});
		expect(m.some((x) => x.includes("derives the foreign key 'host_contact_id'"))).toBe(true);
	});

	test('two roles deriving the same FK column are rejected', () => {
		const m = messages({
			roles: {
				host: { target: 'contact', cardinality: 'one', column: 'lead_id' },
				organizer: { target: 'contact', cardinality: 'one', column: 'lead_id' },
			},
		});
		expect(m.some((x) => x.includes("already the foreign key of role 'host'"))).toBe(true);
	});
});
