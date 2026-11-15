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
