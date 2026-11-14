/**
 * `writesDisabledBy` — the one owner of "does this entity emit create / update / delete" (RFC-0006 §13.2, ADR-046).
 * `entity-locals.js` reads the same function, so the use cases, routes and module providers cannot disagree with
 * the derived surface.
 */
import { describe, expect, it } from 'bun:test';

import { writesDisabledBy } from '../../derived/api/entity';
import { baselineSet, deriveSet } from './_inputs';

const entity = { name: 'email' };
const none = { entity, generate: undefined, inherits: undefined };

describe('writesDisabledBy', () => {
	it('a plain entity emits writes', () => {
		expect(writesDisabledBy(none)).toBeNull();
		expect(writesDisabledBy({ ...none, generate: { writes: true } })).toBeNull();
	});

	it('names the declaration that turned them off', () => {
		expect(writesDisabledBy({ ...none, generate: { writes: false } })).toEqual(['generate', 'writes']);
		expect(writesDisabledBy({ ...none, inherits: 'communication' })).toEqual(['inherits']);
		expect(writesDisabledBy({ ...none, inherits: { base: 'communication', as: 'email' } })).toEqual(['inherits']);
	});

	it('a child has no write use case or route, and says why; its base and plain entities do', () => {
		const surfaces = deriveSet(baselineSet());
		for (const child of ['email', 'meeting']) {
			const s = surfaces.get(child)!;
			expect(s.writesDisabledBy).toEqual({ doc: { kind: 'entity', name: child }, path: ['inherits'] });
			expect(s.useCases.map((u) => u.kind).filter((k) => ['create', 'update', 'delete'].includes(k))).toEqual([]);
			expect(s.http.routes.map((r) => r.verb).filter((v) => v !== 'GET')).toEqual([]);
		}
		for (const other of ['communication', 'email_thread', 'meeting_transcript', 'contact']) {
			const s = surfaces.get(other)!;
			expect(s.writesDisabledBy).toBeUndefined();
			expect(s.useCases.map((u) => u.kind)).toEqual(expect.arrayContaining(['create', 'update', 'delete']));
		}
	});
});
