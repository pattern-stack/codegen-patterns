/**
 * The two fields the Studio canvas's spine rule reads off `/api/graph`
 * (STUDIO-3): `SerializedRelationship.onDelete` — the parsed `on_delete:`,
 * nothing more — and `fkUnique` on a `belongs_to`. Parsed from YAML on disk
 * the way the CLI parses it, so the schema's `on_delete` default is the one
 * under test.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'yaml';

import { buildDomainGraph } from '../../analyzer/graph-builder';
import { serializeDomainGraph } from '../../analyzer/serialize-graph';
import type { SerializedDomainGraph } from '../../analyzer/serialize-graph';
import { loadEntities, resolveReferences } from '../../parser/load-entities';

function serialize(definitions: Record<string, unknown>[]): SerializedDomainGraph {
  const dir = mkdtempSync(join(tmpdir(), 'serialize-graph-'));
  try {
    for (const d of definitions) {
      const name = (d.entity as { name: string }).name;
      writeFileSync(join(dir, `${name}.yaml`), yaml.stringify(d));
    }
    const { entities, issues } = loadEntities(dir, { tablePrefix: '' });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    resolveReferences(entities);
    return serializeDomainGraph(buildDomainGraph(entities));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const parent = (name: string, plural: string) => ({
  entity: { name, plural },
  fields: { label: { type: 'string', required: true } },
});

const graph = serialize([
  parent('hub', 'hubs'),
  parent('zone', 'zones'),
  parent('lane', 'lanes'),
  parent('dock', 'docks'),
  {
    entity: { name: 'spoke', plural: 'spokes' },
    fields: { hub_id: { type: 'uuid', required: true, unique: true } },
    relationships: {
      hub: { type: 'belongs_to', target: 'hub', foreign_key: 'hub_id', on_delete: 'cascade' },
      zone: { type: 'belongs_to', target: 'zone', foreign_key: 'zone_id' },
      lane: { type: 'belongs_to', target: 'lane', foreign_key: 'lane_id' },
      dock: { type: 'belongs_to', target: 'dock', foreign_key: 'dock_id', nullable: true, on_delete: 'set_null' },
    },
    unique_indexes: [{ fields: ['zone_id'] }, { fields: ['lane_id', 'dock_id'] }],
  },
]);

const rel = (name: string) => graph.entities.spoke!.relationships[name]!;
const edge = (name: string) => graph.edges.find((e) => e.from === 'spoke' && e.relationship.name === name)!;

describe('serializeDomainGraph — fkUnique', () => {
  it('a field-level `unique: true` on the FK column makes it unique', () => {
    expect(rel('hub').fkUnique).toBe(true);
  });

  it('a single-column `unique_indexes:` entry makes it unique', () => {
    expect(rel('zone').fkUnique).toBe(true);
  });

  it('a composite `unique_indexes:` entry does not make either column unique', () => {
    expect(rel('lane').fkUnique).toBe(false);
    expect(rel('dock').fkUnique).toBe(false);
  });

  it('the edge list carries the same answer as the entity map', () => {
    expect(['hub', 'zone', 'lane', 'dock'].map((n) => edge(n).relationship.fkUnique)).toEqual([true, true, false, false]);
  });
});

describe('serializeDomainGraph — onDelete', () => {
  it('exposes the parsed `on_delete:`', () => {
    expect(rel('hub').onDelete).toBe('cascade');
    expect(rel('dock').onDelete).toBe('set_null');
    expect(edge('hub').relationship.onDelete).toBe('cascade');
  });

  it("is the schema's default, `restrict`, when the YAML says nothing", () => {
    expect(rel('zone').onDelete).toBe('restrict');
    expect(edge('zone').relationship.onDelete).toBe('restrict');
  });
});
