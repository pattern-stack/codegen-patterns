/**
 * RFC-0006 §3.1 (#875, S3) — the two edges a joined-table child adds to the
 * relation graph, and the base scope it adds to the child's scope.
 *
 * Runs on the §13.1 fixture family (`test/fixtures/inheritance/entities/`),
 * parsed through the real entity schema. The frontend graph calls this same
 * `buildRelationGraph`, so these are also the edges `graph/descriptor.ts` carries.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { buildRelationGraph, entityScope, hopCanDropTarget } from '../../../emitters/relations/build-graph';
import { buildRelationsManifest } from '../../../emitters/relations/emit-manifest';
import type { EntityRegistryEntry, RelationsEmitContext } from '../../../emitters/relations/types';
import { EntityDefinitionSchema, type EntityDefinition } from '../../../schema/entity-definition.schema';
import { findYamlFiles } from '../../../utils/find-yaml-files';
import { FAMILY_DIR } from '../../parser/inheritance-family';

function familyContext(): RelationsEmitContext {
	const defs = findYamlFiles(FAMILY_DIR)
		.map((file) => EntityDefinitionSchema.parse(parseYaml(readFileSync(join(file), 'utf8'))))
		.sort((a, b) => a.entity.name.localeCompare(b.entity.name));
	const entry = (d: EntityDefinition): EntityRegistryEntry => ({
		name: d.entity.name,
		plural: d.entity.plural,
		table: d.entity.plural,
		className: d.entity.name,
		classNamePlural: d.entity.plural,
		camelName: d.entity.name,
		pluralCamelName: d.entity.plural,
		sync: null,
	});
	return {
		entities: defs.map(entry),
		definitions: new Map(defs.map((d) => [d.entity.name, d])),
		junctions: [],
		tenancyColumn: 'tenant_id',
	};
}

function edge(ctx: RelationsEmitContext, table: string, key: string) {
	const found = buildRelationGraph(ctx)
		.tables.find((t) => t.table === table)
		?.edges.find((e) => e.key === key);
	if (!found) throw new Error(`no edge ${table}.${key}`);
	return found;
}

describe('inherits — two edges per child (RFC-0006 §3.1)', () => {
	const ctx = familyContext();

	it('child → base: <base name>, to-one, never optional, joined id → id', () => {
		const e = edge(ctx, 'meetings', 'communication');
		expect(e.cardinality).toBe('one');
		expect(e.optional).toBe(false);
		expect(e.inherits).toBe('base');
		expect(e.from).toEqual({ table: 'meetings', column: 'id' });
		expect(e.to).toEqual({ table: 'communications', column: 'id' });
	});

	it('base → child: <child name>, to-one, optional (a base row of another kind has none)', () => {
		for (const child of ['meeting', 'email']) {
			const e = edge(ctx, 'communications', child);
			expect(e.cardinality).toBe('one');
			expect(e.optional).toBe(true);
			expect(e.inherits).toBe('child');
			expect(e.from).toEqual({ table: 'communications', column: 'id' });
			expect(e.to.column).toBe('id');
		}
	});

	it('the key is the child ENTITY name camelCased, not the kind value (`as:`)', () => {
		// `transcript_communication_part` is the `meeting` kind of `communication_part`.
		const e = edge(ctx, 'communication_parts', 'transcriptCommunicationPart');
		expect(e.inherits).toBe('child');
		expect(e.targetTable).toBe('transcript_communication_parts');
		const back = edge(ctx, 'transcript_communication_parts', 'communicationPart');
		expect(back.inherits).toBe('base');
		expect(back.optional).toBe(false);
	});

	it('the child → base edge is optional:false although the base declares soft_delete (the documented exception)', () => {
		const e = edge(ctx, 'transcript_communication_parts', 'communicationPart');
		expect(e.targetScope?.softDelete).toBe(true);
		// `hopCanDropTarget` alone would say the hop can drop its target…
		expect(hopCanDropTarget(null, e.targetScope)).toBe(true);
		// …the child's own scope (`baseScope`) already requires the base row, so the edge is not nullable.
		expect(e.optional).toBe(false);
	});

	it('an edge that is not part of an inheritance pair carries no marker', () => {
		const e = edge(ctx, 'meetings', 'transcripts');
		expect(e.inherits).toBeUndefined();
	});

	it('a NOT NULL `belongs_to` INTO a child is optional when its source is unscoped: the child is now tenant-scoped', () => {
		// Before S3 a child declared no scope, so this hop was unscoped (a cross-tenant read, charter I3) and
		// non-optional. The child's scope is its base's tenant column, so the hop carries it and can drop the row.
		const e = edge(ctx, 'meeting_transcripts', 'meeting');
		expect(e.targetScope?.tenantScoped).toBe(true);
		expect(e.optional).toBe(true);
	});

	it('a `belongs_to` into a child whose base is soft-deleted can drop the row for any source', () => {
		const e = buildRelationGraph(ctx).entityScopes.find((s) => s.table === 'transcript_communication_parts')!;
		expect(hopCanDropTarget({ tenantScoped: true, tenantColumn: 'tenantId', softDelete: false, userTracking: false, enforcement: 'strict' }, e.scope)).toBe(true);
	});
});

describe('inherits — the child`s scope (RFC-0006 §2.3)', () => {
	const ctx = familyContext();
	const def = (name: string) => ctx.definitions.get(name)!;

	it('a tenant-only family: the child is scoped on its own tenant column and gains NO base scope', () => {
		const scope = buildRelationGraph(ctx).entityScopes.find((s) => s.table === 'meetings')?.scope;
		expect(scope).toEqual({
			tenantScoped: true,
			tenantColumn: 'tenantId',
			softDelete: false,
			userTracking: false,
			enforcement: 'strict',
		});
		expect(scope?.baseScope).toBeUndefined();
	});

	it('a soft-delete base: the child gains the base`s guard as `baseScope`', () => {
		const scope = buildRelationGraph(ctx).entityScopes.find((s) => s.table === 'transcript_communication_parts')?.scope;
		expect(scope).toEqual({
			tenantScoped: true,
			tenantColumn: 'tenantId',
			softDelete: false,
			userTracking: false,
			enforcement: 'strict',
			baseScope: { table: 'communication_parts', softDelete: true, userTracking: false },
		});
	});

	it('the manifest renders it, and the two edges', () => {
		const out = buildRelationsManifest(buildRelationGraph(ctx));
		expect(out).toContain(
			"export const TRANSCRIPT_COMMUNICATION_PARTS_SCOPE = tableScope(schema.transcript_communication_parts, { tenantScoped: true, tenantColumn: 'tenantId', softDelete: false, userTracking: false, enforcement: 'strict', baseScope: { table: schema.communication_parts, softDelete: true, userTracking: false } });",
		);
		expect(out).toMatch(
			/communication: r\.one\.communications\(\{ from: r\.meetings\.id, to: r\.communications\.id, optional: false, where: \{ RAW: \(t\) => hopScope\(t, COMMUNICATIONS_SCOPE, 'meetings\.communication'\) \} \}\),/,
		);
		expect(out).toMatch(
			/meeting: r\.one\.meetings\(\{ from: r\.communications\.id, to: r\.meetings\.id, optional: true, where: \{ RAW: \(t\) => hopScope\(t, MEETINGS_SCOPE, 'communications\.meeting'\) \} \}\),/,
		);
	});

	it('a child scoped without its base is an error — an absent input is never read as unscoped', () => {
		expect(() => entityScope(def('meeting'), 'tenant_id')).toThrow(/inherits 'communication' but its base was not supplied/);
	});

	it('a child whose base is missing from the entity set cannot have its scope derived', () => {
		const partial = familyContext();
		partial.entities = partial.entities.filter((e) => e.name !== 'communication');
		partial.definitions.delete('communication');
		expect(() => buildRelationGraph(partial)).toThrow(/inherits 'communication', which is not in the entity set/);
	});
});

describe('the relation key of a family edge has one owner (digit segments)', () => {
	// `comm_2` / `call_2`: the two camelCase primitives in the tree disagree on `_2` (`comm2` vs `comm_2`). The key a
	// generated `with:` prints and the key the manifest names must be the same string.
	const base = EntityDefinitionSchema.parse({
		entity: { name: 'comm_2', plural: 'comm_2s' },
		discriminator: 'kind',
		fields: { kind: { type: 'enum', choices: ['call_2', 'other'], required: true } },
	});
	const child = EntityDefinitionSchema.parse({
		entity: { name: 'call_2', plural: 'call_2s' },
		inherits: 'comm_2',
		fields: {},
	});

	it('the manifest and the printed repository keys agree', async () => {
		const entry = (d: EntityDefinition): EntityRegistryEntry => ({
			name: d.entity.name,
			plural: d.entity.plural,
			table: d.entity.plural,
			className: d.entity.name,
			classNamePlural: d.entity.plural,
			camelName: d.entity.name,
			pluralCamelName: d.entity.plural,
			sync: null,
		});
		const ctx: RelationsEmitContext = {
			entities: [entry(base), entry(child)],
			definitions: new Map([base, child].map((d) => [d.entity.name, d])),
			junctions: [],
			tenancyColumn: 'tenant_id',
		};
		const graph = buildRelationGraph(ctx);
		const keyOn = (table: string) => graph.tables.find((t) => t.table === table)!.edges.map((e) => e.key);
		expect(keyOn('call_2s')).toEqual(['comm2']);
		expect(keyOn('comm_2s')).toEqual(['call2']);

		// @ts-ignore -- plain-ESM hygen helper, no types
		const { familyReads } = await import('../../../../templates/_shared/inheritance.mjs');
		// @ts-ignore
		const { entityLookupFrom, entityModuleNaming } = await import('../../../../templates/_shared/entity-naming.mjs');
		const lookup = entityLookupFrom([base.entity, child.entity], { definitions: [base, child] });
		const run = (def: EntityDefinition) =>
			familyReads({
				entityName: def.entity.name,
				definition: def,
				lookup,
				ownNaming: entityModuleNaming(def.entity, 'modules'),
				modulesDir: 'modules',
				baseBehaviors: [],
			});
		expect(run(child).child.relKey).toBe('comm2');
		expect(run(base).base.children.map((c: { relKey: string }) => c.relKey)).toEqual(['call2']);
	});
});

describe('inherits — a user_tracking base (RFC-0006 §2.3)', () => {
	it("the child's baseScope carries userTracking: true, and the manifest renders it", () => {
		const base = EntityDefinitionSchema.parse({
			entity: { name: 'note_base', plural: 'note_bases' },
			behaviors: ['user_tracking'],
			discriminator: 'kind',
			fields: { kind: { type: 'enum', choices: ['memo', 'other'], required: true } },
		});
		const child = EntityDefinitionSchema.parse({
			entity: { name: 'memo', plural: 'memos' },
			inherits: 'note_base',
			fields: {},
		});
		const entry = (d: EntityDefinition): EntityRegistryEntry => ({
			name: d.entity.name,
			plural: d.entity.plural,
			table: d.entity.plural,
			className: d.entity.name,
			classNamePlural: d.entity.plural,
			camelName: d.entity.name,
			pluralCamelName: d.entity.plural,
			sync: null,
		});
		const ctx: RelationsEmitContext = {
			entities: [entry(base), entry(child)],
			definitions: new Map([base, child].map((d) => [d.entity.name, d])),
			junctions: [],
			tenancyColumn: 'tenant_id',
		};
		const graph = buildRelationGraph(ctx);
		const scope = graph.entityScopes.find((s) => s.table === 'memos')?.scope;
		expect(scope?.baseScope).toEqual({ table: 'note_bases', softDelete: false, userTracking: true });
		expect(buildRelationsManifest(graph)).toContain('baseScope: { table: schema.note_bases, softDelete: false, userTracking: true }');
	});
});
