/**
 * `runtime/http/includes.ts` — the allowlist at request time (REL-2 §5, #587).
 *
 * Charter I6: a client never supplies an include tree. It names paths, and the
 * generated controller looks each one up in a map the emitter compiled. These
 * tests pin the two properties that follow — the tree is always one of finitely
 * many literals, and anything not named is rejected — plus the merge rule, which
 * is the only place two allowlisted fragments meet.
 */
import { describe, expect, it } from 'bun:test';

import {
	IncludeNotAllowedError,
	parseIncludeParam,
	resolveAllowedInclude,
} from '../../../../runtime/http/includes';

/** A route allowlist shaped exactly as `api-includes.ts` emits one. */
const ALLOW = {
	contacts: { contacts: true },
	opportunities: { opportunities: true },
	'opportunities.account': { opportunities: { with: { account: true } } },
} as const;

describe('parseIncludeParam', () => {
	it('is empty for absent / null / blank input', () => {
		expect(parseIncludeParam(undefined)).toEqual([]);
		expect(parseIncludeParam(null)).toEqual([]);
		expect(parseIncludeParam('')).toEqual([]);
		expect(parseIncludeParam('   ')).toEqual([]);
		expect(parseIncludeParam(',,')).toEqual([]);
	});

	it('splits on commas, trims, and keeps request order', () => {
		expect(parseIncludeParam(' opportunities.account , contacts ')).toEqual([
			'opportunities.account',
			'contacts',
		]);
	});
});

describe('resolveAllowedInclude', () => {
	it('is undefined when nothing was asked for — the plain read path', () => {
		expect(resolveAllowedInclude(undefined, ALLOW)).toBeUndefined();
		expect(resolveAllowedInclude('', ALLOW)).toBeUndefined();
	});

	it('returns the allowlisted fragment itself for a single path', () => {
		expect(resolveAllowedInclude('contacts', ALLOW)).toEqual({ contacts: true });
	});

	it('rejects a path the allowlist does not name, naming the path', () => {
		try {
			resolveAllowedInclude('contacts,secrets', ALLOW);
			throw new Error('expected a rejection');
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(IncludeNotAllowedError);
			const e = err as IncludeNotAllowedError;
			expect(e.code).toBe('include_not_allowed');
			expect(e.path).toBe('secrets');
		}
	});

	it('an ABSENT allowlist is "allow nothing", not "allow everything"', () => {
		// The state every entity is in until it declares `api.includes` — which is
		// what makes REL-2 change no HTTP behaviour until a consumer opts in.
		expect(resolveAllowedInclude(undefined, undefined)).toBeUndefined();
		expect(() => resolveAllowedInclude('contacts', undefined)).toThrow(
			IncludeNotAllowedError,
		);
	});

	it('rejects an attempt to reach a deeper path than the allowlist names', () => {
		expect(() => resolveAllowedInclude('contacts.account', ALLOW)).toThrow(
			IncludeNotAllowedError,
		);
	});

	it('merges two fragments key-wise', () => {
		expect(resolveAllowedInclude('contacts,opportunities', ALLOW)).toEqual({
			contacts: true,
			opportunities: true,
		});
	});

	it('the deeper fragment wins when one path is a prefix of another', () => {
		expect(resolveAllowedInclude('opportunities,opportunities.account', ALLOW)).toEqual({
			opportunities: { with: { account: true } },
		});
		// Order-independent: `true` loses to `{ with: … }` either way.
		expect(resolveAllowedInclude('opportunities.account,opportunities', ALLOW)).toEqual({
			opportunities: { with: { account: true } },
		});
	});

	it('never mutates the emitted fragments — they are shared by every request', () => {
		const before = JSON.stringify(ALLOW);
		resolveAllowedInclude('opportunities,opportunities.account,contacts', ALLOW);
		resolveAllowedInclude('opportunities.account,opportunities', ALLOW);
		expect(JSON.stringify(ALLOW)).toBe(before);
	});

	it('a repeated path is idempotent', () => {
		expect(resolveAllowedInclude('contacts,contacts', ALLOW)).toEqual({ contacts: true });
	});

	it('merges nested `with` maps rather than replacing them', () => {
		const allow = {
			a: { rel: { with: { x: true } } },
			b: { rel: { with: { y: true } } },
		} as const;
		expect(resolveAllowedInclude('a,b', allow)).toEqual({
			rel: { with: { x: true, y: true } },
		});
	});
});
