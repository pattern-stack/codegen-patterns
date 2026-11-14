/**
 * One input, two spellings (PLAN §4.3, R3): hygen hands `deriveEntityApiSurface` raw YAML, the CLI zod-parsed
 * definitions. The two must derive the same surface, or Studio would show what the generator does not emit.
 *
 * The concrete hazard: the schema fills defaults a raw document leaves absent (`api` ⇒ `true`, `on_delete` ⇒
 * `restrict`, …), so a reader that only works on one form passes the other's tests.
 */

import { describe, expect, it } from 'bun:test';

import { baselineSet, deriveSet, parsedSet, type DefinitionSet } from './_inputs';
import { RENDER_MATRIX } from './_render-matrix';

function check(label: string, set: DefinitionSet): void {
	it(`${label}: derive(raw) ≡ derive(parsed)`, () => {
		const raw = deriveSet(set);
		const parsed = deriveSet(parsedSet(set));
		expect(raw.size).toBe(set.entities.length);
		expect(raw.size).toBeGreaterThan(0);
		expect(Object.fromEntries(parsed)).toEqual(Object.fromEntries(raw));
	});
}

describe('api-surface derivation — raw YAML and zod-parsed definitions agree', () => {
	check('the baseline fixture set', baselineSet());
	for (const c of RENDER_MATRIX) check(c.id, c);
});
