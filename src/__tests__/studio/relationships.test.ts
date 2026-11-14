/**
 * `POST|PUT /api/relationships` request parsing (STUDIO-0, #698).
 *
 * The body comes from a browser form, so a typo in a key must be an error
 * rather than a silently dropped field — a rejected `kinds:` is a message the
 * user can act on; an ignored one is a preview of something they did not ask
 * for.
 */
import { afterAll, describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	RelationshipRequestError,
	parseRelationshipRequest,
	previewRelationship,
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

describe('`inherits` (RFC-0006, #875 S6)', () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-inherits-'));
	afterAll(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.mkdirSync(path.join(project, 'entities'), { recursive: true });
	const write = (name: string, body: string) => fs.writeFileSync(path.join(project, 'entities', `${name}.yaml`), body);
	write(
		'communication',
		'entity:\n  name: communication\n  plural: communications\ndiscriminator: kind\nfields:\n  kind:\n    type: enum\n    choices: [meeting, email]\n    required: true\n',
	);
	write('meeting', '# the child\nentity:\n  name: meeting\n  plural: meetings\nfields:\n  title:\n    type: string\n    required: true\n');
	write('email', 'entity:\n  name: email\n  plural: emails\ninherits: communication\nfields:\n  subject:\n    type: string\n');

	it('is an accepted kind, with `as` carried through options', () => {
		expect(parseRelationshipRequest({ from: 'meeting', to: 'communication', kind: 'inherits', options: { as: 'meeting' } }).kind).toBe(
			'inherits',
		);
	});

	it('writes a top-level `inherits:` on the CHILD, short form, keeping the file’s comments', () => {
		const [file, ...rest] = previewRelationship(project, { from: 'meeting', to: 'communication', kind: 'inherits' });
		expect(rest).toEqual([]);
		expect(file?.path).toBe('entities/meeting.yaml');
		expect(file?.content).toContain('# the child');
		expect(file?.content).toMatch(/^inherits: communication$/m);
		expect(file?.content).not.toContain('relationships:');
	});

	it('writes the long form when `as` names another kind value', () => {
		const [file] = previewRelationship(project, { from: 'meeting', to: 'communication', kind: 'inherits', options: { as: 'email' } });
		expect(file?.content).toMatch(/inherits:\n {2}base: communication\n {2}as: email/);
	});

	it('refuses a child that already inherits, itself, and a base that does not exist', () => {
		expect(() => previewRelationship(project, { from: 'email', to: 'communication', kind: 'inherits' })).toThrow(/already declares/);
		expect(() => previewRelationship(project, { from: 'meeting', to: 'meeting', kind: 'inherits' })).toThrow(/cannot inherit itself/);
		expect(() => previewRelationship(project, { from: 'meeting', to: 'nope', kind: 'inherits' })).toThrow(/No entity named 'nope'/);
	});
});
