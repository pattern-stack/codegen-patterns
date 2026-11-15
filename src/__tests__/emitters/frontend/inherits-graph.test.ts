/**
 * RFC-0006 §3.4 (#875, S6) — a joined-table child on the client.
 *
 * Runs the frontend emitter over the family copy the frontend smoke compiles
 * (`test/smoke/fixtures-frontend/entities/`, every entity `sync: electric`) and
 * pins what the accessors promise:
 *
 *  - A12 (second half): the descriptor carries BOTH edges of the pair, edge-for-edge
 *    what REL-1's own builder produced (the `inherits` marker is the emitter's, not
 *    the descriptor's);
 *  - the child-to-base hop is an INNER join and carries no `| undefined`;
 *  - `<Child>WithBase`: the type, the fragment, both hooks — on an `electric` child
 *    only, a `sync: api` child gets none;
 *  - a base whose every kind has a child has no create route, so nothing emitted
 *    aims a mutation at it — pinned against the backend's own derivation
 *    (`familyReads`), not a copy of it.
 *
 * The byte snapshot of the three family graph files is `test/frontend-graph-golden/inherits/`:
 *   UPDATE_GRAPH_GOLDEN=1 bun test src/__tests__/emitters/frontend/inherits-graph.test.ts
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildBackendLocals } from '../../../../templates/entity/new/backend/entity-locals.js';
import { withEntities } from '../../backend/_entity-lookup';
import { hasCreateRoute } from '../../../emitters/frontend/emit-utils';
import { createEntityLookup } from '../../../../templates/_shared/entity-naming.mjs';
import { buildClientGraph, emitFrontendSet, loadFrontendEmitContext } from '../../../emitters/frontend/index';
import { buildRelationGraph } from '../../../emitters/relations/build-graph';
import type { FrontendEmitContext } from '../../../emitters/frontend/types';

const ENTITIES = resolve(import.meta.dir, '../../../../test/smoke/fixtures-frontend/entities');
const SNAPSHOT_DIR = resolve(import.meta.dir, '../../../../test/frontend-graph-golden/inherits');
const UPDATE = process.env.UPDATE_GRAPH_GOLDEN === '1';
const SNAPSHOT_FILES = ['graph/meeting.ts', 'graph/communication.ts', 'graph/transcript_communication_part.ts'];

const tmpRoot = mkdtempSync(join(tmpdir(), 'fe-inherits-graph-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function load(entitiesDir: string): FrontendEmitContext {
	const loaded = loadFrontendEmitContext(tmpRoot, { frontend: { auth: { function: null } } }, { entitiesDir });
	if (loaded.skip !== undefined) throw new Error(`family fixture failed to load: ${loaded.skip}`);
	return loaded.ctx;
}

const ctx = load(ENTITIES);
const outDir = join(tmpRoot, 'generated');
emitFrontendSet(ctx, outDir);
const read = (rel: string): string => readFileSync(join(outDir, rel), 'utf-8');

describe('inherits on the client graph — the descriptor (A12, second half)', () => {
	const descriptor = read('graph/descriptor.ts');
	const server = buildRelationGraph({
		entities: ctx.entities,
		definitions: ctx.definitions ?? new Map(),
		junctions: ctx.junctions ?? [],
		tenancyColumn: ctx.config.tenancyColumn,
	});

	it('carries the child-to-base edge, never optional, and the base-to-child edges', () => {
		expect(descriptor).toContain("communication: { kind: 'one', target: 'communications', from: 'id', to: 'id', optional: false }");
		expect(descriptor).toContain("meeting: { kind: 'one', target: 'meetings', from: 'id', to: 'id', optional: true }");
		expect(descriptor).toContain("email: { kind: 'one', target: 'emails', from: 'id', to: 'id', optional: true }");
	});

	it('is edge-for-edge REL-1’s: the marker rides on the edge, not into the descriptor', () => {
		const edges = buildClientGraph(ctx).nodes.flatMap((n) => n.relations.map((r) => `${n.collection}.${r.key}`)).sort();
		const serverEdges = server.tables.flatMap((t) => t.edges.map((e) => `${t.table}.${e.key}`)).sort();
		expect(edges).toEqual(serverEdges);
		expect(descriptor).not.toContain('inherits');
	});

	it('names an edge to a leaf entity (no edge of its own) — `communication_participant.party`', () => {
		// `party` declares no relationships, so it has no node: the accessor still has to name it.
		expect(read('graph/communication_participant.ts')).toContain(
			".join({ party: partyCollection }, ({ row, party }) =>",
		);
	});
});

describe('inherits on the client graph — the child accessor (§3.4)', () => {
	const meeting = read('graph/meeting.ts');

	it('INNER-joins the child-to-base hop in the root query, and only that hop', () => {
		expect(meeting).toContain('.innerJoin({ communication: communicationCollection }');
		expect(meeting).not.toMatch(/\.(join|leftJoin)\(\{ communication:/);
		// a transcript's `meeting` is an ordinary to-one: left-joined, still `| undefined`
		expect(meeting).toContain('.join({ meeting: meetingCollection }');
		expect(meeting).toContain('{ meeting: Meeting | undefined }');
	});

	it('types the base hop without `| undefined`', () => {
		expect(meeting).toContain('{ communication: Communication }');
		expect(meeting).not.toContain('{ communication: Communication | undefined }');
	});

	it('emits <Child>WithBase: the fragment and both hooks here, the flat type owned by the api client', () => {
		expect(meeting).toContain("import type { MeetingWithBase } from '../api/meeting';");
		expect(meeting).toContain('export type { MeetingWithBase };');
		expect(meeting).not.toContain('export type MeetingWithBase =');
		expect(meeting).toContain('export function meetingsWithBase(q: InitialQueryBuilder)');
		expect(meeting).toContain('.innerJoin({ base: communicationCollection }, ({ row, base }) => eq(row.id, base.id))');
		expect(meeting).toContain('export function useMeetingsWithBase()');
		expect(meeting).toContain('export function useMeetingWithBase(id: string | null | undefined)');
		const api = read('api/meeting.ts');
		expect(api).toContain("export type MeetingWithBase = globalThis.Omit<Communication, 'kind'> & Meeting;");
		expect(api).toContain("export type MeetingFlatInput = globalThis.Partial<globalThis.Omit<MeetingWithBase, 'id' | 'kind'>>;");
		expect(api).toContain('create: (data: MeetingFlatInput): Promise<MeetingWithBase>');
		expect(api).toContain('get: (id: string): Promise<MeetingWithBase>');
		expect(api).toContain('update: (id: string, data: MeetingFlatInput): Promise<MeetingWithBase>');
		expect(read('entities/meeting.ts')).toContain('createEntityHooks<Meeting, MeetingFlatInput, MeetingFlatInput>');
	});

	it('omits the base’s OWN discriminator, not a hard-coded `kind`', () => {
		const dir = join(tmpRoot, 'category-family');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, 'item.yaml'),
			'entity:\n  name: item\n  plural: items\n  sync: electric\ndiscriminator: category\nfields:\n  category:\n    type: enum\n    choices: [book, film]\n    required: true\n  kind:\n    type: string\n    required: true\n',
		);
		writeFileSync(
			join(dir, 'book.yaml'),
			'entity:\n  name: book\n  plural: books\n  sync: electric\ninherits: item\nfields:\n  title:\n    type: string\n    required: true\n',
		);
		const out = join(tmpRoot, 'category-out');
		emitFrontendSet(load(dir), out);
		const api = readFileSync(join(out, 'api/book.ts'), 'utf-8');
		// the discriminator `category` is omitted; the base's ordinary field `kind` survives into the flat type
		expect(api).toContain("globalThis.Omit<Item, 'category'> & Book");
		expect(api).toContain("globalThis.Omit<BookWithBase, 'id' | 'category'>");
		expect(api).not.toContain("'kind'");
	});

	it('names a child whose plural is not `<name>s` from its own YAML', () => {
		const part = read('graph/transcript_communication_part.ts');
		expect(part).toContain('export function transcriptCommunicationPartsWithBase(');
		expect(part).toContain('export function useTranscriptCommunicationPartsWithBase()');
	});

	it('gives the BASE no WithBase helper', () => {
		expect(read('graph/communication.ts')).not.toContain('WithBase');
	});

	it('gives a `sync: api` family no accessors and no helper (its REST routes already return the flat shape)', () => {
		const dir = join(tmpRoot, 'api-family');
		mkdirSync(dir, { recursive: true });
		for (const name of ['communication', 'meeting', 'email', 'email_thread', 'meeting_transcript']) {
			writeFileSync(join(dir, `${name}.yaml`), readFileSync(join(ENTITIES, `${name}.yaml`), 'utf-8').replace(/^ {2}sync: electric$/m, '  sync: api'));
		}
		const out = join(tmpRoot, 'api-out');
		emitFrontendSet(load(dir), out);
		expect(existsSync(join(out, 'graph/meeting.ts'))).toBe(false);
		// …but its edges are still declared: an `api` root is a deferral, not an error.
		expect(readFileSync(join(out, 'graph/descriptor.ts'), 'utf-8')).toContain("communication: { kind: 'one', target: 'communications'");
	});

	it('an `electric` base reaching an `api` child is a generation error, naming the relation', () => {
		const dir = join(tmpRoot, 'mixed-family');
		mkdirSync(dir, { recursive: true });
		for (const name of ['communication', 'meeting', 'email', 'email_thread', 'meeting_transcript']) {
			const text = readFileSync(join(ENTITIES, `${name}.yaml`), 'utf-8');
			writeFileSync(join(dir, `${name}.yaml`), name === 'meeting' ? text.replace(/^ {2}sync: electric$/m, '  sync: api') : text);
		}
		expect(() => emitFrontendSet(load(dir), join(tmpRoot, 'mixed-out'))).toThrow(/cross-mode relation 'meeting'/);
	});
});

describe('a base with a child for every kind has no create route (S5)', () => {
	it('emits no create hook and no POST for communication_part, and keeps both for communication', () => {
		expect(read('api/communication-part.ts')).not.toContain("'POST'");
		// `\b`: `useCreateCommunicationParticipant` is a different hook that shares the prefix.
		expect(read('entities/communication-part.ts')).not.toMatch(/useCreateCommunicationPart\b/);
		expect(read('entities/index.ts')).not.toMatch(/useCreateCommunicationPart\b/);
		expect(read('api/communication.ts')).toContain("'POST'");
		expect(read('entities/communication.ts')).toContain('useCreate: useCreateCommunication,');
		// typed away, in all three places: the hooks, the api stub, the field capabilities
		expect(read('entities/communication-part.ts')).toContain('createEntityHooks<CommunicationPart, never>');
		expect(read('api/communication-part.ts')).toContain('create: (_data: never): Promise<CommunicationPart>');
		expect(read('fields/communication-part.ts')).toContain('create: false,');
		expect(read('fields/communication.ts')).toContain('create: true,');
	});

	it('agrees with the backend’s REAL `generateCreate` for every entity of the set', () => {
		// buildBackendLocals is what renders the controller: a change to its `generateCreate` turns this red.
		const lookup = createEntityLookup(ENTITIES, { tablePrefix: '' });
		const definitions = ctx.definitions!;
		let noCreate = 0;
		for (const name of definitions.keys()) {
			const locals = buildBackendLocals(lookup.definition(name), { ...withEntities(), entityLookup: lookup });
			const has = hasCreateRoute(ctx.entities.find((e) => e.name === name)!, ctx);
			expect(has, name).toBe(locals.generateCreate as boolean);
			if (!has) noCreate += 1;
		}
		expect(noCreate).toBe(1); // communication_part; communication keeps its base-only kind `message`
	});
});

describe('golden', () => {
	if (UPDATE) {
		it('regenerates the checked-in snapshot', () => {
			rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
			for (const rel of SNAPSHOT_FILES) {
				const dest = join(SNAPSHOT_DIR, rel);
				mkdirSync(join(dest, '..'), { recursive: true });
				writeFileSync(dest, read(rel));
			}
			expect(existsSync(join(SNAPSHOT_DIR, SNAPSHOT_FILES[0]!))).toBe(true);
		});
		return;
	}
	it('graph/meeting.ts, graph/communication.ts and the long-form child are byte-identical to the snapshot', () => {
		for (const rel of SNAPSHOT_FILES) {
			expect(read(rel), `mismatch in ${rel}`).toBe(readFileSync(join(SNAPSHOT_DIR, rel), 'utf-8'));
		}
	});
});
