/**
 * Frontend graph accessors — the RULES (FE-REL §6.3).
 *
 * The golden tree locks the bytes; these lock the decisions, so a regression
 * names itself instead of arriving as a diff hunk:
 *
 *  - a cross-mode hop is a generation error, not a degraded fetch loop (§4.4);
 *  - an `api` root is a DEFERRAL, visible in the output, not an error (§4.3);
 *  - junction collections exist only where junction rows can reach the browser;
 *  - the query count is a function of the include SHAPE, never of the data (I4);
 *  - re-emitting the same context is byte-identical (charter I2).
 *
 * Fixtures go through the REAL schemas for REL-1's reason: a fixture the parser
 * would reject cannot quietly pass here, and the `required`/`nullable` defaults
 * these tests lean on are the parser's rather than a hand-written approximation.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';

import {
	buildClientGraph,
	CrossSyncModeHopError,
	junctionCollectionEntry,
} from '../../../emitters/frontend/graph-model';
import {
	buildEntityGraphFile,
	emitGraph,
	graphJunctions,
	ReservedRelationAliasError,
} from '../../../emitters/frontend/emit-graph';
import { emitFrontendSet } from '../../../emitters/frontend';
import type { FrontendEmitContext } from '../../../emitters/frontend/types';
import {
	EntityDefinitionSchema,
	type EntityDefinition,
} from '../../../schema/entity-definition.schema';
import {
	JunctionDefinitionSchema,
	type JunctionDefinition,
} from '../../../schema/junction-definition.schema';
import { config, entry, parsedEntity } from './_helpers';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function definition(
	name: string,
	plural: string,
	fields: Record<string, unknown> = {},
	relationships: Record<string, unknown> = {},
): EntityDefinition {
	return EntityDefinitionSchema.parse({
		entity: { name, plural, table: plural },
		fields,
		relationships,
	});
}

function junction(left: string, right: string): JunctionDefinition {
	return JunctionDefinitionSchema.parse({ pattern: 'Junction', between: [left, right] });
}

/**
 * An `account` ← `contact` pair with both directions declared, plus an
 * edge-less `tag` so a junction can be added without colliding with account's
 * own `contacts` key (REL-1 rejects two relations under one key, and rightly).
 */
function pairContext(opts: {
	accountSync?: 'api' | 'electric' | null;
	contactSync?: 'api' | 'electric' | null;
	globalSyncMode?: 'api' | 'electric';
	/** Add the `account ↔ tag` junction (and the `tag` entity it needs). */
	withJunction?: boolean;
	extraRelations?: Record<string, unknown>;
} = {}): FrontendEmitContext {
	const account = entry('account', 'accounts', opts.accountSync ?? null);
	const contact = entry('contact', 'contacts', opts.contactSync ?? null);
	const tag = entry('tag', 'tags', opts.accountSync ?? null);
	const entities = opts.withJunction ? [account, contact, tag] : [account, contact];

	const definitions = new Map<string, EntityDefinition>([
		[
			'account',
			definition(
				'account',
				'accounts',
				{ name: { type: 'string', required: true } },
				{
					contacts: { type: 'has_many', target: 'contact', foreign_key: 'account_id' },
					...(opts.extraRelations ?? {}),
				},
			),
		],
		[
			'contact',
			definition(
				'contact',
				'contacts',
				{ account_id: { type: 'uuid', required: true } },
				{ account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } },
			),
		],
		['tag', definition('tag', 'tags', { label: { type: 'string', required: true } })],
	]);

	return {
		entities,
		parsed: new Map(entities.map((e) => [e.name, parsedEntity(e)])),
		config: config({ globalSyncMode: opts.globalSyncMode ?? 'electric' }),
		definitions,
		junctions: opts.withJunction ? [junction('account', 'tag')] : [],
	};
}

// ---------------------------------------------------------------------------

describe('cross-mode hops are a generation error (FE-REL §4.4)', () => {
	it('throws naming both entities and the relation', () => {
		const ctx = pairContext({ accountSync: 'electric', contactSync: 'api' });
		let thrown: unknown;
		try {
			buildClientGraph(ctx);
		} catch (err: unknown) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(CrossSyncModeHopError);
		const err = thrown as CrossSyncModeHopError;
		expect(err.sourceEntity).toBe('account');
		expect(err.targetEntity).toBe('contact');
		expect(err.relation).toBe('contacts');
		expect(err.message).toContain('account');
		expect(err.message).toContain('contact');
		expect(err.message).toContain('contacts');
	});

	it('points at the v2 id-set design rather than degrading to a fetch loop', () => {
		const ctx = pairContext({ accountSync: 'electric', contactSync: 'api' });
		expect(() => buildClientGraph(ctx)).toThrow(/id-set/);
	});

	it('does NOT fire when both sides sync the same way', () => {
		expect(() =>
			buildClientGraph(pairContext({ accountSync: 'electric', contactSync: 'electric' })),
		).not.toThrow();
		// Both `api`: nothing is navigable yet, but nothing is an error either.
		expect(() =>
			buildClientGraph(
				pairContext({ accountSync: 'api', contactSync: 'api', globalSyncMode: 'api' }),
			),
		).not.toThrow();
	});

	it('fires when a junction cannot reach the browser', () => {
		// Global `api` ⇒ junction rows have no way into the browser (`junction new`
		// emits no controller), so an `electric` parent cannot join through them.
		// The hop that names it is the row-level edge to the link table, which
		// REL-1 emits alongside every `through` hop — so the junction is always
		// caught, and always by this one rule.
		const ctx = pairContext({
			accountSync: 'electric',
			contactSync: 'electric',
			globalSyncMode: 'api',
			withJunction: true,
		});
		let thrown: unknown;
		try {
			buildClientGraph(ctx);
		} catch (err: unknown) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(CrossSyncModeHopError);
		const err = thrown as CrossSyncModeHopError;
		expect(err.sourceEntity).toBe('account');
		expect(err.targetEntity).toBe('account_tag');
		expect(err.relation).toBe('accountTags');
	});
});

describe('an `api` root is a visible deferral, not an error (FE-REL §4.3)', () => {
	const ctx = pairContext({
		accountSync: 'api',
		contactSync: 'api',
		globalSyncMode: 'api',
	});
	const graph = buildClientGraph(ctx);

	it('still declares the edges', () => {
		const accounts = graph.nodes.find((n) => n.collection === 'accounts');
		expect(accounts?.relations.map((r) => r.key)).toEqual(['contacts']);
	});

	it('records every api entity as deferred, with REL-2 as the reason', () => {
		expect(graph.deferred.map((d) => d.entity).sort()).toEqual(['account', 'contact']);
		expect(graph.deferred[0]?.reason).toContain('REL-2');
	});

	it('writes the deferral into the descriptor rather than dropping it silently', () => {
		const dir = mkdtempSync(join(tmpdir(), 'fe-graph-def-'));
		try {
			emitGraph(ctx, dir, graph);
			const descriptor = readFileSync(join(dir, 'graph', 'descriptor.ts'), 'utf-8');
			expect(descriptor).toContain('Accessors deliberately NOT emitted');
			expect(descriptor).toContain('account');
			// …and no accessor module was written for them.
			expect([...new Glob('**/*.ts').scanSync(dir)].sort()).toEqual([
				'graph/descriptor.ts',
				'graph/index.ts',
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('junction collections exist only where junction rows can sync', () => {
	it('are emitted under the electric default', () => {
		const ctx = pairContext({ withJunction: true });
		const graph = buildClientGraph(ctx);
		expect(graphJunctions(ctx, graph).map((j) => j.name)).toEqual(['account_tag']);
	});

	it('are NOT emitted under the api default — there is no REST surface for them', () => {
		const ctx = pairContext({
			accountSync: 'api',
			contactSync: 'api',
			globalSyncMode: 'api',
			withJunction: true,
		});
		expect(graphJunctions(ctx, buildClientGraph(ctx))).toEqual([]);
	});

	it('derive their naming from REL-1 identity, with the composite key columns', () => {
		const j = junctionCollectionEntry(junction('opportunity', 'contact'));
		expect(j).toEqual({
			name: 'opportunity_contact',
			plural: 'opportunity_contacts',
			collectionKey: 'opportunityContacts',
			camelName: 'opportunityContact',
			className: 'OpportunityContact',
			keyColumns: ['opportunityId', 'contactId'],
		});
	});

	it('are not navigator roots — their own edges are reported, not emitted', () => {
		const ctx = pairContext({ withJunction: true });
		const graph = buildClientGraph(ctx);
		const node = graph.nodes.find((n) => n.collection === 'accountTags');
		expect(node?.relations).toEqual([]);
		expect(
			graph.warnings.some((w) => w.includes('accountTags') && w.includes('not client-navigable')),
		).toBe(true);
	});
});

describe('the query count is a function of the include shape (charter I4)', () => {
	const ctx = pairContext({ withJunction: true });
	const graph = buildClientGraph(ctx);
	const node = graph.nodes.find((n) => n.collection === 'accounts');
	const source = buildEntityGraphFile(node!, graph, ctx);

	it('emits one useLiveQuery for the root plus one per to-many relation', () => {
		const manyCount = node!.relations.filter((r) => r.kind === 'many').length;
		const queries = source.match(/useLiveQuery\(/g) ?? [];
		expect(manyCount).toBeGreaterThan(0);
		expect(queries.length).toBe(1 + manyCount);
	});

	it('has no loop that could issue a query per row', () => {
		// The only `.map(` in the body is the pure row-shaping one, and there is
		// no `for`/`while`/`await` anywhere — an N+1 has nowhere to hide.
		expect(source).not.toMatch(/\bfor\s*\(/);
		expect(source).not.toMatch(/\bwhile\s*\(/);
		expect(source).not.toMatch(/\bawait\b/);
	});

	it('disables a branch that was not included instead of running it', () => {
		expect(source).toContain(': undefined,');
		expect(source).toContain('inc.contacts');
	});

	it('joins a to-one hop into the query that already carries its source row', () => {
		const contactNode = graph.nodes.find((n) => n.collection === 'contacts');
		const contactSource = buildEntityGraphFile(contactNode!, graph, ctx);
		// `contact belongs_to account` is a to-one: joined into the ROOT query, so
		// the hook count is unchanged by it.
		expect(contactSource).toContain('.join({ account: accountCollection }');
		const manyCount = contactNode!.relations.filter((r) => r.kind === 'many').length;
		expect((contactSource.match(/useLiveQuery\(/g) ?? []).length).toBe(1 + manyCount);
	});
});

describe('the emitted types', () => {
	const ctx = pairContext({ withJunction: true });
	const graph = buildClientGraph(ctx);
	const source = buildEntityGraphFile(
		graph.nodes.find((n) => n.collection === 'accounts')!,
		graph,
		ctx,
	);

	it('type a to-many as an array and a to-one as `| undefined`', () => {
		expect(source).toContain('contacts: Array<');
		const contactSource = buildEntityGraphFile(
			graph.nodes.find((n) => n.collection === 'contacts')!,
			graph,
			ctx,
		);
		expect(contactSource).toContain('{ account: Account | undefined }');
	});

	it('gate every relation on the include, so an omitted one is not on the type', () => {
		expect(source).toContain("Sel<I, 'contacts'> extends undefined ? unknown :");
	});

	it('infer the include at the call site (`const` type parameter)', () => {
		expect(source).toContain('<const I extends AccountInclude>');
	});
});

describe('a relation key that would shadow a query alias is an error', () => {
	it('throws naming the relation and the reserved set', () => {
		const ctx = pairContext({
			extraRelations: {
				row: { type: 'has_many', target: 'contact', foreign_key: 'account_id' },
			},
		});
		const graph = buildClientGraph(ctx);
		const node = graph.nodes.find((n) => n.collection === 'accounts');
		expect(() => buildEntityGraphFile(node!, graph, ctx)).toThrow(ReservedRelationAliasError);
	});
});

describe('emission is idempotent (charter I2)', () => {
	it('re-emitting the same context is byte-identical', () => {
		const ctx = pairContext({ withJunction: true });
		const a = mkdtempSync(join(tmpdir(), 'fe-graph-a-'));
		const b = mkdtempSync(join(tmpdir(), 'fe-graph-b-'));
		try {
			emitFrontendSet(ctx, a);
			emitFrontendSet(ctx, b);
			const filesA = [...new Glob('**/*.ts').scanSync(a)].sort();
			const filesB = [...new Glob('**/*.ts').scanSync(b)].sort();
			expect(filesA).toEqual(filesB);
			expect(filesA).toContain('graph/descriptor.ts');
			expect(filesA).toContain('graph/account.ts');
			// NAME-2 (#695): the emitted stem is kebab. The junction's table stays
			// `account_tags` and its YAML `junctions/account_tag.yaml`.
			expect(filesA).toContain('collections/account-tag.ts');
			for (const rel of filesA) {
				expect(readFileSync(join(a, rel), 'utf-8'), rel).toBe(
					readFileSync(join(b, rel), 'utf-8'),
				);
			}
		} finally {
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	});

	it('emits nothing graph-shaped for a context with no definitions', () => {
		const ctx = pairContext();
		const bare: FrontendEmitContext = {
			entities: ctx.entities,
			parsed: ctx.parsed,
			config: ctx.config,
		};
		const dir = mkdtempSync(join(tmpdir(), 'fe-graph-bare-'));
		try {
			emitFrontendSet(bare, dir);
			expect([...new Glob('graph/**/*.ts').scanSync(dir)]).toEqual([]);
			expect(readFileSync(join(dir, 'index.ts'), 'utf-8')).not.toContain("'./graph/index'");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
