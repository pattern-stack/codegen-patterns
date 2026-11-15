/**
 * `writesDisabledBy` — the one owner of "does this entity emit create / update / delete" (RFC-0006 §13.2, ADR-046).
 * `entity-locals.js` reads `apiSurface.useCases`, which is built from this function, so the use cases, routes and
 * module providers cannot disagree with the derived surface.
 */
import { describe, expect, it } from 'bun:test';

import { createDisabledBy, writesDisabledBy } from '../../derived/api/entity';
import { baseOnlyKinds, discriminatorKindsOf, enumChoices } from '../../schema/inheritance';
import { baselineSet, deriveSet } from './_inputs';

const entity = { name: 'email' };
const none = { entity, generate: undefined };

describe('writesDisabledBy', () => {
	it('a plain entity emits writes', () => {
		expect(writesDisabledBy(none)).toBeNull();
		expect(writesDisabledBy({ ...none, generate: { writes: true } })).toBeNull();
	});

	it('names the declaration that turned them off', () => {
		expect(writesDisabledBy({ ...none, generate: { writes: false } })).toEqual(['generate', 'writes']);
	});

	it('a child emits writes (S5): its pair write is the repository\'s, its DTOs are flat', () => {
		const surfaces = deriveSet(baselineSet());
		for (const child of ['email', 'meeting']) {
			const s = surfaces.get(child)!;
			expect(s.writesDisabledBy).toBeUndefined();
			expect(s.useCases.map((u) => u.kind)).toEqual(expect.arrayContaining(['create', 'update', 'delete']));
			expect(s.http.routes.map((r) => r.verb)).toEqual(expect.arrayContaining(['POST', 'PATCH', 'DELETE']));
		}
	});
});

describe('createDisabledBy', () => {
	const kinds = ['email', 'meeting'];
	const child = (as: string) => ({ name: as, as });

	it('a non-base, and a base with no child table, have a create', () => {
		expect(createDisabledBy({}, [], null)).toBeNull();
		expect(createDisabledBy({ discriminator: 'kind' }, [], ['info', 'alert'])).toBeNull();
	});

	it('a base with a base-only kind has a create', () => {
		expect(createDisabledBy({ discriminator: 'kind' }, [child('email')], kinds)).toBeNull();
	});

	it('a base whose every kind has a child table has none, caused by its discriminator', () => {
		expect(createDisabledBy({ discriminator: 'kind' }, [child('email'), child('meeting')], kinds)).toEqual(['discriminator']);
	});

	it('an unknown kind list on a base with children is an error, not "every kind is base-only"', () => {
		expect(() => createDisabledBy({ discriminator: 'kind' }, [child('email')], null)).toThrow(/kinds are unknown/);
	});

	it('an omitted kind list (a JS caller that leaves the key out) gets the named error too', () => {
		expect(() => createDisabledBy({ discriminator: 'kind' }, [child('email')], undefined as never)).toThrow(/kinds are unknown/);
	});

	it('the derived surface agrees: the baseline base keeps its create (it has a base-only kind)', () => {
		const surfaces = deriveSet(baselineSet());
		const base = surfaces.get('communication')!;
		expect(base.createDisabledBy).toBeUndefined();
		expect(base.useCases.map((u) => u.kind)).toContain('create');
		expect(base.http.routes.map((r) => r.verb)).toContain('POST');
	});
});

describe('enumChoices / baseOnlyKinds — the one resolver and the one computation', () => {
	const owner = { fields: { kind: { choices: ['a', 'b'] } } };

	it('reads literal choices, or the owner\'s through one choices_of hop', () => {
		expect(enumChoices({ choices: ['x', 'y'] }, () => undefined)).toEqual(['x', 'y']);
		expect(enumChoices({ choices_of: 'owner.kind' }, (n) => (n === 'owner' ? owner : undefined))).toEqual(['a', 'b']);
	});

	it('is undefined — unknown, never "none" — for a missing field, owner or owner field', () => {
		expect(enumChoices(undefined, () => undefined)).toBeUndefined();
		expect(enumChoices({ choices_of: 'owner.kind' }, () => undefined)).toBeUndefined();
		expect(enumChoices({ choices_of: 'owner.nope' }, () => owner)).toBeUndefined();
		expect(enumChoices({}, () => undefined)).toBeUndefined();
	});

	it('discriminatorKindsOf is enumChoices of the discriminator field', () => {
		const defs = [{ entity: { name: 'owner' }, ...owner }];
		expect(discriminatorKindsOf({ discriminator: 'kind', fields: { kind: { choices_of: 'owner.kind' } } }, defs)).toEqual(['a', 'b']);
		expect(discriminatorKindsOf({ fields: {} }, defs)).toBeNull();
	});

	it('baseOnlyKinds is the kinds with no child; empty exactly when createDisabledBy fires', () => {
		expect(baseOnlyKinds(['a', 'b', 'c'], ['a'])).toEqual(['b', 'c']);
		expect(baseOnlyKinds(['a', 'b'], ['a', 'b'])).toEqual([]);
		expect(createDisabledBy({ discriminator: 'kind' }, [{ name: 'a', as: 'a' }, { name: 'b', as: 'b' }], ['a', 'b'])).toEqual(['discriminator']);
	});
});
