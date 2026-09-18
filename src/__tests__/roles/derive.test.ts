/**
 * CAP-2 — the role → belongs_to derivation shared by the hygen prompt and the
 * analyzer parser.
 */

import { describe, test, expect } from 'bun:test';
import {
	deriveRoleRelationships,
	junctionNamesFor,
	roleForeignKey,
} from '../../roles/derive.ts';

describe('roleForeignKey', () => {
	test('defaults to <role>_<target>_id', () => {
		expect(roleForeignKey('host', 'contact')).toBe('host_contact_id');
		expect(roleForeignKey('about', 'account')).toBe('about_account_id');
	});

	test('an explicit column wins', () => {
		expect(roleForeignKey('host', 'contact', 'organizer_id')).toBe('organizer_id');
	});
});

describe('deriveRoleRelationships', () => {
	test('a one-role becomes a belongs_to keyed by the role, indexed, restrict by default', () => {
		const derived = deriveRoleRelationships({
			host: { target: 'contact', cardinality: 'one' },
		});
		expect(derived).toEqual({
			host: {
				type: 'belongs_to',
				target: 'contact',
				foreign_key: 'host_contact_id',
				on_delete: 'restrict',
				role: 'host',
				index: true,
			},
		});
	});

	test('nullable and on_delete carry through; nullable is omitted when unset', () => {
		const derived = deriveRoleRelationships({
			about: { target: 'account', cardinality: 'one', nullable: true, on_delete: 'set_null' },
			host: { target: 'contact', cardinality: 'one' },
		});
		expect(derived.about?.nullable).toBe(true);
		expect(derived.about?.on_delete).toBe('set_null');
		expect('nullable' in (derived.host ?? {})).toBe(false);
	});

	test('a many-role derives nothing — its junction already owns the edge', () => {
		expect(
			deriveRoleRelationships({
				attendees: { target: 'contact', cardinality: 'many', via: 'meeting_contact' },
			}),
		).toEqual({});
	});

	test('absent or empty roles derive nothing', () => {
		expect(deriveRoleRelationships(undefined)).toEqual({});
		expect(deriveRoleRelationships(null)).toEqual({});
		expect(deriveRoleRelationships({})).toEqual({});
	});

	test('two one-roles to the same target stay two edges with two keys', () => {
		const derived = deriveRoleRelationships({
			host: { target: 'contact', cardinality: 'one' },
			organizer: { target: 'contact', cardinality: 'one' },
		});
		expect(Object.keys(derived).sort()).toEqual(['host', 'organizer']);
		expect(derived.host?.foreign_key).toBe('host_contact_id');
		expect(derived.organizer?.foreign_key).toBe('organizer_contact_id');
	});
});

describe('junctionNamesFor', () => {
	test('both declaration orders', () => {
		expect(junctionNamesFor('meeting', 'contact')).toEqual([
			'meeting_contact',
			'contact_meeting',
		]);
	});
});
