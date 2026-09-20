/**
 * `POST|PUT /api/relationships` request parsing (STUDIO-0, #698).
 *
 * The body comes from a browser form, so a typo in a key must be an error
 * rather than a silently dropped field — a rejected `kinds:` is a message the
 * user can act on; an ignored one is a preview of something they did not ask
 * for.
 */
import { describe, it, expect } from 'bun:test';

import {
	RelationshipRequestError,
	parseRelationshipRequest,
} from '../../studio/server/relationships';

describe('parseRelationshipRequest', () => {
	it('accepts a minimal body and defaults options', () => {
		expect(
			parseRelationshipRequest({ from: 'contact', to: 'opportunity', kind: 'many_to_many' }),
		).toEqual({ from: 'contact', to: 'opportunity', kind: 'many_to_many', options: {} });
	});

	it('carries options through', () => {
		const parsed = parseRelationshipRequest({
			from: 'contact',
			to: 'account',
			kind: 'belongs_to',
			options: { required: true, onDelete: 'cascade' },
		});
		expect(parsed.options).toEqual({ required: true, onDelete: 'cascade' });
	});

	it('REJECTS an unknown top-level key rather than ignoring it', () => {
		expect(() =>
			parseRelationshipRequest({
				from: 'contact',
				to: 'opportunity',
				kinds: 'many_to_many',
			}),
		).toThrow(RelationshipRequestError);
	});

	it('names every unknown key in the message', () => {
		try {
			parseRelationshipRequest({
				from: 'a',
				to: 'b',
				kind: 'belongs_to',
				through: 'x',
				temporal: true,
			});
			throw new Error('should have thrown');
		} catch (err) {
			// `through` and `temporal` belong under `options`, one level down —
			// the exact mistake this rejection exists to name.
			expect((err as Error).message).toContain("'through'");
			expect((err as Error).message).toContain("'temporal'");
			expect((err as Error).message).toContain('from, to, kind, options');
		}
	});

	it('rejects a missing or empty `from`', () => {
		expect(() => parseRelationshipRequest({ to: 'b', kind: 'belongs_to' })).toThrow('`from`');
		expect(() => parseRelationshipRequest({ from: '', to: 'b', kind: 'belongs_to' })).toThrow(
			'`from`',
		);
	});

	it('rejects a missing `to`', () => {
		expect(() => parseRelationshipRequest({ from: 'a', kind: 'belongs_to' })).toThrow('`to`');
	});

	it('rejects an unknown kind, listing the four that exist', () => {
		expect(() => parseRelationshipRequest({ from: 'a', to: 'b', kind: 'owns' })).toThrow(
			'belongs_to, has_many, has_one, many_to_many',
		);
	});

	it('rejects a non-object body', () => {
		expect(() => parseRelationshipRequest(null)).toThrow('JSON object');
		expect(() => parseRelationshipRequest('from=a')).toThrow('JSON object');
	});

	it('rejects options that are not an object', () => {
		expect(() =>
			parseRelationshipRequest({ from: 'a', to: 'b', kind: 'belongs_to', options: [] }),
		).toThrow('`options`');
	});
});
