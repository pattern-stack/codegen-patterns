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
	declaresOwnRelation,
	IncludeAllowlistError,
	readRouteKeys,
} from '../../../emitters/relations/build-includes';
import { buildApiIncludes } from '../../../emitters/relations/emit-includes';
import type { RelationsEmitContext } from '../../../emitters/relations/types';
import type { EntityRegistryEntry } from '../../../parser/entity-registry';
import { withEntities } from '../../backend/_entity-lookup';
import {
	EntityDefinitionSchema,
	type EntityDefinition,
} from '../../../schema/entity-definition.schema';
import { JunctionDefinitionSchema } from '../../../schema/junction-definition.schema';

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

function ctxOf(raws: unknown[], junctions: unknown[] = []): RelationsEmitContext {
	const defs = raws.map(parse);
	return {
		entities: registry(defs),
		definitions: new Map(defs.map((d) => [d.entity.name, d])),
		junctions: junctions.map((j) => JunctionDefinitionSchema.parse(j)),
	};
}

function compile(raws: unknown[], junctions: unknown[] = []) {
	const ctx = ctxOf(raws, junctions);
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
			queries: [{ name: 'search', filters: ['name'] }],
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

	// The two halves of the allowlist are derived differently — this one from the
	// whole graph, the controller's from the entity's own `relationships:` — and a
	// silent disagreement is an allowlist that 400s every path with no explanation.
	it('an entity with no relationship of its OWN cannot carry an allowlist', () => {
		const TAG = {
			entity: { name: 'tag', plural: 'tags', table: 'tags' },
			fields: { label: { type: 'string', required: true } },
			// No `relationships:` — in a real project its edges would come from a
			// junction YAML, which this emitter sees and the hygen half does not.
			api: { includes: { list: { max_depth: 1, paths: ['whatever'] } } },
		};
		let message = '';
		try {
			compile([TAG, ACCOUNT, CONTACT, OPPORTUNITY]);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(IncludeAllowlistError);
			message = err instanceof Error ? err.message : '';
		}
		expect(message).toContain('tag.api.includes');
		expect(message).toContain('declares no direct relationship of its own');
		expect(message).toContain('#679');
	});

	it('an entity whose only relationship is transitive cannot either', () => {
		expect(() =>
			compile([
				{
					entity: { name: 'tag', plural: 'tags', table: 'tags' },
					fields: { label: { type: 'string', required: true } },
					relationships: {
						deep: {
							type: 'has_many',
							target: 'contact',
							foreign_key: 'account_id',
							through: 'a.b',
						},
					},
					api: { includes: { list: { max_depth: 1, paths: ['deep'] } } },
				},
				ACCOUNT,
				CONTACT,
				OPPORTUNITY,
			]),
		).toThrow(/declares no direct relationship of its own/);
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

// The rule `declaresOwnRelation` encodes has a twin in the hygen half
// (`includes`). They decide the same thing from the same YAML and must not
// drift: if the emitter says "allowlist is fine" and the template says "no
// include surface", every allowlisted path is a silent 400.
describe('declaresOwnRelation matches the template’s includes', () => {
	const cases: Array<{ name: string; relationships: unknown; expected: boolean }> = [
		{ name: 'none declared', relationships: undefined, expected: false },
		{ name: 'empty block', relationships: {}, expected: false },
		{
			name: 'one belongs_to',
			relationships: {
				account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' },
			},
			expected: true,
		},
		{
			name: 'only a transitive one',
			relationships: {
				deep: { type: 'has_many', target: 'contact', foreign_key: 'account_id', through: 'a.b' },
			},
			expected: false,
		},
		{
			name: 'a transitive one BESIDE a direct one',
			relationships: {
				deep: { type: 'has_many', target: 'contact', foreign_key: 'account_id', through: 'a.b' },
				account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' },
			},
			expected: true,
		},
	];

	for (const { name, relationships, expected } of cases) {
		it(`${name} → ${expected}`, async () => {
			const raw = {
				entity: { name: 'thing', plural: 'things', table: 'things' },
				fields: { account_id: { type: 'uuid' } },
				...(relationships === undefined ? {} : { relationships }),
			};
			expect(declaresOwnRelation(parse(raw))).toBe(expected);

			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			// @ts-ignore -- plain-ESM hygen extension, no types
			const { buildBackendLocals } = await import(
				'../../../../templates/entity/new/backend/entity-locals.js'
			);
			// NAME-0 (#630): cross-entity naming resolves through an entity lookup,
			// so a hand-built call needs the same base locals `prompt.js` passes.
			const locals = buildBackendLocals(raw, withEntities()) as { includes: boolean };
			expect(locals.includes).toBe(expected);
		});
	}
});

// ---------------------------------------------------------------------------
// #742 — the YAML relationship name and the relation key name the same edge
// ---------------------------------------------------------------------------

const LEAGUE = {
	entity: { name: 'league', plural: 'leagues', table: 'leagues' },
	fields: { name: { type: 'string', required: true } },
	relationships: {
		fantasy_teams: { type: 'has_many', target: 'fantasy_team', foreign_key: 'league_id' },
	},
};

const FANTASY_TEAM = {
	entity: { name: 'fantasy_team', plural: 'fantasy_teams', table: 'fantasy_teams' },
	fields: { league_id: { type: 'uuid', required: true } },
	relationships: {
		home_league: { type: 'belongs_to', target: 'league', foreign_key: 'league_id' },
	},
};

const SPONSOR_BRAND = {
	entity: { name: 'sponsor_brand', plural: 'sponsor_brands', table: 'sponsor_brands' },
	fields: { name: { type: 'string' } },
};

const TROPHY = {
	entity: { name: 'trophy', plural: 'trophies', table: 'trophies' },
	fields: { league_id: { type: 'uuid' } },
};

const LEAGUE_WITH_TROPHIES = {
	...LEAGUE,
	relationships: {
		...LEAGUE.relationships,
		trophies: { type: 'has_many', target: 'trophy', foreign_key: 'league_id' },
	},
};

function leagueWith(maxDepth: number, paths: string[], base: object = LEAGUE) {
	return {
		...base,
		api: { includes: { find_by_id: { max_depth: maxDepth, paths } } },
	};
}

function pathsOf(out: ReturnType<typeof compile>) {
	return out[0]?.routes[0]?.paths.map((p) => p.path);
}

function messageOf(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(IncludeAllowlistError);
		return (e as Error).message;
	}
	throw new Error('expected IncludeAllowlistError');
}

describe('buildIncludeAllowlists — path spelling (#742)', () => {
	it('S1: the YAML relationship name compiles to the relation key', () => {
		const out = compile([leagueWith(1, ['fantasy_teams']), FANTASY_TEAM]);
		expect(out[0]?.routes[0]?.paths.map((p) => [p.path, p.fragment, p.depth])).toEqual([
			['fantasyTeams', '{ fantasyTeams: true }', 1],
		]);
	});

	it('S2: every hop is normalised and the fragment is written in keys', () => {
		const out = compile([leagueWith(2, ['fantasy_teams.home_league']), FANTASY_TEAM]);
		expect(out[0]?.routes[0]?.paths.map((p) => [p.path, p.fragment, p.depth])).toEqual([
			['fantasyTeams', '{ fantasyTeams: true }', 1],
			[
				'fantasyTeams.homeLeague',
				'{ fantasyTeams: { with: { homeLeague: true } } }',
				2,
			],
		]);
	});

	it('S3: both spellings name one edge, so there is one entry', () => {
		const out = compile([leagueWith(1, ['fantasy_teams', 'fantasyTeams']), FANTASY_TEAM]);
		expect(pathsOf(out)).toEqual(['fantasyTeams']);
	});

	it('S4: junction-derived keys are spelled from their source names', () => {
		const out = compile(
			[leagueWith(1, ['sponsor_brands', 'league_sponsor_brands']), FANTASY_TEAM, SPONSOR_BRAND],
			[{ pattern: 'Junction', between: ['league', 'sponsor_brand'] }],
		);
		expect(pathsOf(out)).toEqual(['leagueSponsorBrands', 'sponsorBrands']);
	});

	it('S5: the emitted map is keyed by the relation key', () => {
		const out = buildApiIncludes(compile([leagueWith(1, ['fantasy_teams']), FANTASY_TEAM]));
		expect(out).toContain('\t\tfantasyTeams: { fantasyTeams: true },');
		expect(out).not.toContain('fantasy_teams');
	});
});

describe('buildIncludeAllowlists — a miss says what exists (#742)', () => {
	it('M1: a near miss lists the keys and suggests one', () => {
		const msg = messageOf(() => compile([leagueWith(1, ['fantasy_team']), FANTASY_TEAM]));
		expect(msg).toContain("names no relation at 'fantasy_team'");
		expect(msg).toContain("has no relation 'fantasyTeam' (written 'fantasy_team')");
		expect(msg).toContain('Relation keys at this hop: fantasyTeams.');
		expect(msg).toContain("Did you mean 'fantasyTeams'?");
	});

	it('M2: a nested miss reports the hop it missed at', () => {
		const msg = messageOf(() =>
			compile([leagueWith(2, ['fantasy_teams.league']), FANTASY_TEAM]),
		);
		expect(msg).toContain("names no relation at 'fantasy_teams.league'");
		expect(msg).toContain("table 'fantasy_teams'");
		expect(msg).toContain('Relation keys at this hop: homeLeague.');
		// 'league' -> 'homeLeague' is distance 4, over the limit of 3: no guess.
		expect(msg).not.toContain('Did you mean');
	});

	it('M6: a suggestion at exactly the distance limit is still made', () => {
		const msg = messageOf(() =>
			compile([
				{ ...ACCOUNT, api: { includes: { find_by_id: { max_depth: 1, paths: ['opportunity'] } } } },
				CONTACT,
				OPPORTUNITY,
			]),
		);
		// 'opportunity' -> 'opportunities' is distance 3; limit is max(2, floor(13/3)) = 4.
		expect(msg).toContain("Did you mean 'opportunities'?");
	});

	it('M7: an `api: false` miss quotes the declared (snake) spelling', () => {
		const msg = messageOf(() =>
			compile([leagueWith(1, ['fantasy_teams']), { ...FANTASY_TEAM, api: false }]),
		);
		expect(msg).toContain("'fantasy_teams'");
		expect(msg).toContain("declares 'api: false'");
	});

	it('M3: a case slip is suggested', () => {
		const msg = messageOf(() => compile([leagueWith(1, ['FantasyTeams']), FANTASY_TEAM]));
		expect(msg).toContain("Did you mean 'fantasyTeams'?");
	});

	it('M4: nothing close, so keys are listed and nothing is guessed', () => {
		const msg = messageOf(() =>
			compile([
				{ ...ACCOUNT, api: { includes: { find_by_id: { max_depth: 1, paths: ['nope'] } } } },
				CONTACT,
				OPPORTUNITY,
			]),
		);
		expect(msg).toContain('Relation keys at this hop: contacts, opportunities.');
		expect(msg).not.toContain('Did you mean');
	});

	it('M5: a hop into a table with no relations says so', () => {
		const msg = messageOf(() =>
			compile([leagueWith(2, ['trophies.x'], LEAGUE_WITH_TROPHIES), FANTASY_TEAM, TROPHY]),
		);
		expect(msg).toContain("Table 'trophies' has no relations");
	});
});
