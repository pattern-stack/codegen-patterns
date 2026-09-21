/**
 * Frontend graph accessors — golden tree + the I1 proof (FE-REL §6.2).
 *
 * Two things are locked here, and the second is the one that matters.
 *
 * **1. A byte-exact snapshot** of the `graph/` tree for a fixture set with
 * every shape the emitter has a branch for: a self-referential to-one, two
 * `has_many` inverses, a `has_one` inverse, an irregular plural resolved
 * through the registry (`person` → `persons`, NOT `pluralize('person')` =
 * "people"), and a junction contributing both the `through` hop and the
 * row-level hop to the link table.
 *
 * **2. The client descriptor is REL-1's graph, not a second derivation of it.**
 * `graph/descriptor.ts` is parsed back and compared edge-for-edge against what
 * `buildRelationGraph` — the Drizzle manifest's own builder — produces for the
 * same context. A snapshot diff alone would not prove that: it would pass just
 * as happily if someone re-derived the edges here and happened to agree. This
 * assertion fails the moment the two stop being one declaration (charter I1).
 *
 * The fixture set is `test/relations-golden/` — REL-1's OWN fixtures, used
 * unchanged. Sharing them is deliberate: one YAML set feeding both emitters is
 * what makes the comparison above meaningful rather than circular.
 *
 * Regenerate after intentional emitter changes:
 *   UPDATE_GRAPH_GOLDEN=1 bun test src/__tests__/emitters/frontend/graph-golden.test.ts
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import {
	buildClientGraph,
	emitFrontendSet,
	loadFrontendEmitContext,
} from '../../../emitters/frontend/index';
import { buildRelationGraph } from '../../../emitters/relations/build-graph';

const FIXTURES = resolve(import.meta.dir, '../../../../test/relations-golden');
const SNAPSHOT_DIR = resolve(
	import.meta.dir,
	'../../../../test/frontend-graph-golden/snapshot',
);
const UPDATE = process.env.UPDATE_GRAPH_GOLDEN === '1';

function listFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string): void => {
		if (!existsSync(d)) return;
		for (const ent of readdirSync(d, { withFileTypes: true })) {
			const full = join(d, ent.name);
			if (ent.isDirectory()) walk(full);
			else out.push(relative(dir, full));
		}
	};
	walk(dir);
	return out.sort();
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'fe-graph-golden-'));
const outDir = join(tmpRoot, 'generated');

const loaded = loadFrontendEmitContext(
	FIXTURES,
	// Auth off keeps the snapshot free of the header lines FE-2 already covers;
	// the sync mode is the default (`electric`) for every fixture, which is the
	// mode the accessors are emitted for.
	{ frontend: { auth: { function: null } } },
	{
		entitiesDir: join(FIXTURES, 'entities'),
		junctionsDir: join(FIXTURES, 'junctions'),
	},
);
if (loaded.skip !== undefined) {
	throw new Error(`graph fixture failed to load: ${loaded.skip}`);
}
emitFrontendSet(loaded.ctx, outDir);

/** The `graph/` subtree only — the rest of the tree is the FE-2/FE-3 golden's job. */
const graphDir = join(outDir, 'graph');

afterAll(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe('frontend graph golden tree', () => {
	if (UPDATE) {
		it('regenerates the checked-in snapshot', () => {
			if (existsSync(SNAPSHOT_DIR)) rmSync(SNAPSHOT_DIR, { recursive: true });
			mkdirSync(SNAPSHOT_DIR, { recursive: true });
			cpSync(graphDir, SNAPSHOT_DIR, { recursive: true });
			expect(listFiles(SNAPSHOT_DIR).length).toBeGreaterThan(0);
		});
		return;
	}

	it('emits the same file set as the snapshot', () => {
		expect(listFiles(graphDir)).toEqual(listFiles(SNAPSHOT_DIR));
	});

	it('every emitted file is byte-identical to the snapshot', () => {
		for (const rel of listFiles(SNAPSHOT_DIR)) {
			const got = readFileSync(join(graphDir, rel), 'utf-8');
			const want = readFileSync(join(SNAPSHOT_DIR, rel), 'utf-8');
			expect(got, `mismatch in ${rel}`).toBe(want);
		}
	});
});

describe('the client descriptor IS the REL-1 graph (charter I1)', () => {
	const ctx = loaded.ctx;
	const serverGraph = buildRelationGraph({
		entities: ctx.entities,
		definitions: ctx.definitions ?? new Map(),
		junctions: ctx.junctions ?? [],
	});
	const clientGraph = buildClientGraph(ctx);

	it('carries every edge REL-1 emits, minus the junction-rooted ones', () => {
		// REL-1 emits the junction table's own two belongs_to edges for the
		// server's `db.query.<junction>.findMany`. The client store has no entry
		// for a junction, so those are the ONLY edges the projection drops — and
		// it says so in a warning rather than dropping them quietly.
		const junctionTables = new Set(clientGraph.junctions.map((j) => j.collectionKey));

		const serverEdges = serverGraph.tables
			.filter((t) => !junctionTables.has(t.table))
			.flatMap((t) => t.edges.map((e) => `${t.table}.${e.key}`))
			.sort();
		const clientEdges = clientGraph.nodes
			.flatMap((n) => n.relations.map((r) => `${n.collection}.${r.key}`))
			.sort();

		expect(clientEdges).toEqual(serverEdges);
		expect(serverEdges.length).toBeGreaterThan(0);
	});

	it('names every edge with the same columns REL-1 does', () => {
		const serverByKey = new Map(
			serverGraph.tables.flatMap((t) =>
				t.edges.map((e) => [`${t.table}.${e.key}`, e] as const),
			),
		);

		for (const node of clientGraph.nodes) {
			for (const rel of node.relations) {
				const key = `${node.collection}.${rel.key}`;
				const server = serverByKey.get(key);
				expect(server, `no server edge for ${key}`).toBeDefined();
				if (!server) continue;
				expect(rel.kind, key).toBe(server.cardinality);
				expect(rel.target, key).toBe(server.targetTable);
				expect(rel.from, key).toBe(server.from.column);
				expect(rel.to, key).toBe(server.to.column);
				expect(rel.optional, key).toBe(server.optional);
				expect(rel.through?.collection, key).toBe(server.from.through?.table);
				expect(rel.through?.from, key).toBe(server.from.through?.column);
				expect(rel.through?.to, key).toBe(server.to.through?.column);
			}
		}
	});

	it('resolves the irregular plural through the registry, never by pluralizing', () => {
		// `person` declares `plural: persons`; `pluralize('person')` is "people".
		// The RELATION key is the author's (`people`, from contact.yaml), the
		// TARGET is the registry's (`persons`). Getting either from the other
		// would be the ADR-038 violation this asserts against.
		const contacts = clientGraph.nodes.find((n) => n.collection === 'contacts');
		const people = contacts?.relations.find((r) => r.key === 'people');
		expect(people?.target).toBe('persons');

		const descriptor = readFileSync(join(graphDir, 'descriptor.ts'), 'utf-8');
		expect(descriptor).toContain("people: { kind: 'many', target: 'persons'");
		expect(descriptor).not.toContain("target: 'people'");
	});

	it('reports the dropped junction-rooted edges instead of hiding them', () => {
		expect(
			clientGraph.warnings.some(
				(w) => w.includes('opportunityContacts') && w.includes('not client-navigable'),
			),
		).toBe(true);
	});
});
