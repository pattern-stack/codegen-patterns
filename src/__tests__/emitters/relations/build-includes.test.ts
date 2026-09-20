/**
 * The HTTP include allowlist, at generation time — REL-2 §5 (#587).
 *
 * Every rule here is a BUILD error. The property under test is charter I6: the
 * only include trees that can exist at runtime are compile-time literals the
 * emitter resolved against the relation graph, so a typo, an over-deep path, or a
 * path that reaches an `api: false` entity fails the command rather than the
 * request.
 *
 * Contexts are built through `EntityDefinitionSchema.parse` rather than
 * hand-shaped objects, for the reason REL-1's Found #1 records: the schema's
 * defaults are part of the behaviour under test.
 */
import { describe, expect, it } from 'bun:test';

import { buildRelationGraph } from '../../../emitters/relations/build-graph';
import {
	buildIncludeAllowlists,
	IncludeAllowlistError,
	readRouteKeys,
} from '../../../emitters/relations/build-includes';
import { buildApiIncludes } from '../../../emitters/relations/emit-includes';
import type { RelationsEmitContext } from '../../../emitters/relations/types';
import type { EntityRegistryEntry } from '../../../parser/entity-registry';
import {
	EntityDefinitionSchema,
	type EntityDefinition,
} from '../../../schema/entity-definition.schema';

function parse(raw: unknown): EntityDefinition {
	return EntityDefinitionSchema.parse(raw);
}

const ACCOUNT = {
	entity: { name: 'account', plural: 'accounts', table: 'accounts' },
	fields: { name: { type: 'string', required: true } },
	relationships: {
		contacts: { type: 'has_many', target: 'contact', foreign_key: 'account_id' },
		opportunities: {
			type: 'has_many',
			target: 'opportunity',
			foreign_key: 'account_id',
		},
	},
};

const CONTACT = {
	entity: { name: 'contact', plural: 'contacts', table: 'contacts' },
	fields: { account_id: { type: 'uuid', required: true }, email: { type: 'string' } },
	relationships: {
		account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' },
	},
};

const OPPORTUNITY = {
	entity: { name: 'opportunity', plural: 'opportunities', table: 'opportunities' },
	fields: { account_id: { type: 'uuid', required: true }, name: { type: 'string' } },
	relationships: {
		account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' },
	},
};

function registry(defs: EntityDefinition[]): EntityRegistryEntry[] {
	return defs
		.map((d) => ({
			name: d.entity.name,
			plural: d.entity.plural ?? `${d.entity.name}s`,
			table: d.entity.table ?? d.entity.plural ?? `${d.entity.name}s`,
		}))
		.sort((a, b) => a.name.localeCompare(b.name)) as EntityRegistryEntry[];
}

function ctxOf(raws: unknown[]): RelationsEmitContext {
	const defs = raws.map(parse);
	return {
		entities: registry(defs),
		definitions: new Map(defs.map((d) => [d.entity.name, d])),
		junctions: [],
	};
}

function compile(raws: unknown[]) {
	const ctx = ctxOf(raws);
	return buildIncludeAllowlists(ctx, buildRelationGraph(ctx));
}

describe('readRouteKeys', () => {
	it('is find_by_id + list plus one route per `queries:` finder', () => {
		const def = parse({
			...ACCOUNT,
			queries: [{ by: ['name'] }, { by: ['name', 'parent_account_id'] }],
		});
		expect(readRouteKeys(def)).toEqual([
			'find_by_id',
			'list',
			'findByName',
			'findByNameAndParentAccountId',
		]);
	});

	it('excludes the named-search form — it is not a finder (§5.4)', () => {
		const def = parse({
			...ACCOUNT,
			queries: [{ name: 'search', filters: ['name'], paginate: true }],
		});
		expect(readRouteKeys(def)).toEqual(['find_by_id', 'list']);
	});
});

describe('buildIncludeAllowlists — what compiles', () => {
	it('is empty when nothing declares `api.includes` (closed by default)', () => {
		expect(compile([ACCOUNT, CONTACT, OPPORTUNITY])).toEqual([]);
	});

	it('compiles a dot path into a nested include literal', () => {
		const [account] = compile([
			{
				...ACCOUNT,
				api: { includes: { find_by_id: { max_depth: 2, paths: ['opportunities.account'] } } },
			},
			CONTACT,
			OPPORTUNITY,
		]);
		expect(account?.table).toBe('accounts');
		expect(account?.routes).toHaveLength(1);
		expect(account?.routes[0]?.paths.map((p) => [p.path, p.fragment, p.depth])).toEqual([
			['opportunities', '{ opportunities: true }', 1],
			['opportunities.account', '{ opportunities: { with: { account: true } } }', 2],
		]);
	});

	it('a prefix of a declared path is allowed without a second declaration', () => {
		const [account] = compile([
			{
				...ACCOUNT,
				api: {
					includes: { find_by_id: { max_depth: 2, paths: ['contacts', 'opportunities.account'] } },
				},
			},
			CONTACT,
			OPPORTUNITY,
		]);
		expect(account?.routes[0]?.paths.map((p) => p.path)).toEqual([
			'contacts',
			'opportunities',
			'opportunities.account',
		]);
	});

	it('routes are independent — one route does not inherit another route’s paths', () => {
		const [account] = compile([
			{
				...ACCOUNT,
				api: {
					includes: {
						find_by_id: { max_depth: 2, paths: ['opportunities.account'] },
						list: { max_depth: 1, paths: ['contacts'] },
					},
				},
			},
			CONTACT,
			OPPORTUNITY,
		]);
		const byRoute = new Map(account?.routes.map((r) => [r.route, r.paths.map((p) => p.path)]));
		expect(byRoute.get('list')).toEqual(['contacts']);
		expect(byRoute.get('find_by_id')).toEqual(['opportunities', 'opportunities.account']);
	});
});

describe('buildIncludeAllowlists — what fails the build', () => {
	it('a path naming a relation the entity does not have', () => {
		expect(() =>
			compile([
				{ ...ACCOUNT, api: { includes: { list: { max_depth: 1, paths: ['nope'] } } } },
				CONTACT,
				OPPORTUNITY,
			]),
		).toThrow(/names no relation at 'nope'/);
	});

	it('a NESTED segment naming a relation the target does not have', () => {
		expect(() =>
			compile([
				{
					...ACCOUNT,
					api: { includes: { list: { max_depth: 2, paths: ['contacts.nope'] } } },
				},
				CONTACT,
				OPPORTUNITY,
			]),
		).toThrow(/names no relation at 'contacts\.nope'/);
	});

	it('a path deeper than the route’s max_depth — never silently trimmed', () => {
		expect(() =>
			compile([
				{
					...ACCOUNT,
					api: { includes: { list: { max_depth: 1, paths: ['opportunities.account'] } } },
				},
				CONTACT,
				OPPORTUNITY,
			]),
		).toThrow(/is 2 hops deep but max_depth is 1/);
	});

	it('a route key that is not a generated read route', () => {
		expect(() =>
			compile([
				{ ...ACCOUNT, api: { includes: { findByNope: { max_depth: 1, paths: ['contacts'] } } } },
				CONTACT,
				OPPORTUNITY,
			]),
		).toThrow(/'findByNope' is not a generated read route/);
	});

	it('an allowlist declared together with `api: false`', () => {
		expect(() =>
			compile([
				{
					...ACCOUNT,
					api: { enabled: false, includes: { list: { max_depth: 1, paths: ['contacts'] } } },
				},
				CONTACT,
				OPPORTUNITY,
			]),
		).toThrow(/'api.includes' is declared together with 'api: false'/);
	});

	// Gate decision 1 (strict): `api: false` means what ADR-043 §6 says, with no
	// per-path override. The error names BOTH entities.
	it('a path that traverses an `api: false` entity — naming both entities', () => {
		let message = '';
		try {
			compile([
				{
					...ACCOUNT,
					api: { includes: { list: { max_depth: 1, paths: ['contacts'] } } },
				},
				{ ...CONTACT, api: false },
				OPPORTUNITY,
			]);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(IncludeAllowlistError);
			message = err instanceof Error ? err.message : '';
		}
		expect(message).toContain('account.api.includes.list');
		expect(message).toContain("traverses 'contact'");
		expect(message).toContain("declares 'api: false'");
	});

	it('an `api: false` entity is unreachable even at the END of a deeper path', () => {
		expect(() =>
			compile([
				{
					...ACCOUNT,
					api: { includes: { list: { max_depth: 2, paths: ['opportunities.account'] } } },
				},
				CONTACT,
				OPPORTUNITY,
				// `opportunities.account` lands back on account, which is exposed — so
				// make the FIRST hop the closed one instead.
			]),
		).not.toThrow();
		expect(() =>
			compile([
				{
					...ACCOUNT,
					api: { includes: { list: { max_depth: 2, paths: ['opportunities.account'] } } },
				},
				CONTACT,
				{ ...OPPORTUNITY, api: false },
			]),
		).toThrow(/traverses 'opportunity'/);
	});

	it('a transitive relationship is not routable — REL-1 emits no edge for it', () => {
		expect(() =>
			compile([
				{
					...ACCOUNT,
					relationships: {
						...ACCOUNT.relationships,
						deep: {
							type: 'has_many',
							target: 'contact',
							foreign_key: 'account_id',
							through: 'opportunities.contacts',
						},
					},
					api: { includes: { list: { max_depth: 1, paths: ['deep'] } } },
				},
				CONTACT,
				OPPORTUNITY,
			]),
		).toThrow(/names no relation at 'deep'/);
	});
});

describe('buildApiIncludes — the emitted file', () => {
	it('an empty set still writes a file (whole-set, so a stale map is cleared)', () => {
		const out = buildApiIncludes([]);
		expect(out).toContain('@generated by @pattern-stack/codegen');
		expect(out).toContain('No entity declares `api.includes`');
		expect(out).toContain('export {};');
	});

	it('quotes a dot-path key and re-checks every fragment with `satisfies`', () => {
		const out = buildApiIncludes(
			compile([
				{
					...ACCOUNT,
					api: {
						includes: {
							find_by_id: { max_depth: 2, paths: ['contacts', 'opportunities.account'] },
						},
					},
				},
				CONTACT,
				OPPORTUNITY,
			]),
		);
		expect(out).toContain('export const ACCOUNTS_API_INCLUDES = {');
		expect(out).toContain('\tcontacts: { contacts: true },');
		expect(out).toContain(
			"\t\t'opportunities.account': { opportunities: { with: { account: true } } },",
		);
		expect(out).toContain(
			"as const satisfies Readonly<Record<string, RouteIncludes<'accounts'>>>;",
		);
		expect(out).toContain("import type { IncludeOf, Relations } from './relations';");
	});

	it('records each route’s declared cap beside it', () => {
		const out = buildApiIncludes(
			compile([
				{ ...ACCOUNT, api: { includes: { list: { max_depth: 1, paths: ['contacts'] } } } },
				CONTACT,
				OPPORTUNITY,
			]),
		);
		expect(out).toContain('// list — max_depth 1');
	});
});
