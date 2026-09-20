/**
 * The graph → canvas adapter. These are the shapes the whole left pane is
 * derived from, so a regression here is a silently wrong picture of the model.
 */
import { describe, expect, test } from 'bun:test';
import type { SerializedDomainGraph } from '@studio-shared';
import {
  adaptDomainGraph,
  buildEdges,
  classifyEdge,
  entityToNode,
  pascalCase,
  relationshipToNode,
  sourcePathOf,
} from '../adapters/schema-adapter';

type Entity = SerializedDomainGraph['entities'][string];
type RelDef = SerializedDomainGraph['relationshipDefinitions'][string];
type Edge = SerializedDomainGraph['edges'][number];
type Field = Entity['fields'][string];

function field(name: string, over: Partial<Field> = {}): Field {
  return {
    name,
    type: 'string',
    required: false,
    nullable: true,
    unique: false,
    index: false,
    ...over,
  };
}

function entity(name: string, over: Partial<Entity> = {}): Entity {
  return {
    name,
    plural: `${name}s`,
    table: `${name}s`,
    fields: {
      id: field('id', { type: 'uuid', required: true, nullable: false }),
      created_at: field('created_at', { type: 'timestamp' }),
    },
    relationships: {},
    behaviors: ['timestamps'],
    sourcePath: `entities/${name}.yaml`,
    ...over,
  };
}

function relationship(over: Partial<Edge['relationship']> = {}): Edge['relationship'] {
  return {
    name: 'organization',
    type: 'belongs_to',
    target: 'organization',
    foreignKey: 'organization_id',
    resolved: true,
    ...over,
  };
}

function relDef(name: string, from: string, to: string, over: Partial<RelDef> = {}): RelDef {
  return {
    name,
    table: name,
    from,
    to,
    selfReferential: from === to,
    fromColumn: `${from}_id`,
    toColumn: `${to}_id`,
    types: [],
    hasTypes: false,
    temporal: true,
    sourced: false,
    onDeleteFrom: 'cascade',
    onDeleteTo: 'cascade',
    uniqueOn: [],
    fields: {},
    sourcePath: `relationships/${name}.yaml`,
    ...over,
  };
}

function graph(over: Partial<SerializedDomainGraph> = {}): SerializedDomainGraph {
  return { entities: {}, relationshipDefinitions: {}, edges: [], ...over };
}

describe('pascalCase', () => {
  test('joins snake_case segments', () => {
    expect(pascalCase('person_organization')).toBe('PersonOrganization');
  });

  test('tolerates repeated and trailing separators', () => {
    expect(pascalCase('a__b-')).toBe('AB');
  });
});

describe('entityToNode', () => {
  test('carries name, table and pattern onto the card', () => {
    const node = entityToNode(entity('contact', { pattern: 'Integrated' }));
    expect(node.id).toBe('contact');
    expect(node.label).toBe('Contact');
    expect(node.subtitle).toBe('contacts');
    expect(node.kind).toBe('entity');
    expect(node.group).toBe('Integrated');
  });

  test('falls back through patterns to Base', () => {
    expect(entityToNode(entity('a', { patterns: ['Activity'] })).group).toBe('Activity');
    expect(entityToNode(entity('a')).group).toBe('Base');
  });

  test('marks the primary key, foreign keys and system fields', () => {
    const node = entityToNode(
      entity('contact', {
        fields: {
          id: field('id', { type: 'uuid', required: true }),
          org_id: field('org_id', { foreignKey: { table: 'organizations', column: 'id' } }),
          email: field('email', { required: true }),
          nickname: field('nickname'),
          created_at: field('created_at'),
        },
      }),
    );

    expect(node.fields?.map((f) => [f.name, f.role, f.system === true])).toEqual([
      ['id', 'pk', true],
      ['org_id', 'fk', false],
      ['email', 'required', false],
      ['nickname', 'nullable', false],
      ['created_at', 'nullable', true],
    ]);
    expect(node.fieldCount).toBe(5);
  });

  test('records the YAML the entity came from', () => {
    expect(sourcePathOf(entityToNode(entity('contact')))).toBe('entities/contact.yaml');
  });
});

describe('relationshipToNode', () => {
  test('derives flags from the definition', () => {
    const node = relationshipToNode(
      relDef('person_person', 'person', 'person', { temporal: true, sourced: true }),
    );
    expect(node.kind).toBe('relationship');
    expect(node.flags).toEqual(['temporal', 'sourced', 'self-referential']);
    expect(node.from).toBe('person');
    expect(node.to).toBe('person');
  });

  test('maps type direction metadata', () => {
    const node = relationshipToNode(
      relDef('person_org', 'person', 'organization', {
        hasTypes: true,
        types: [
          { name: 'employed_by', bidirectional: false, directed: true },
          { name: 'advisor', bidirectional: true, directed: false, inverse: 'advises' },
          { name: 'plain', bidirectional: false, directed: false },
        ],
      }),
    );

    expect(node.types).toEqual([
      { name: 'employed_by', direction: 'directed', inverseName: undefined },
      { name: 'advisor', direction: 'bidirectional', inverseName: 'advises' },
      { name: 'plain', direction: undefined, inverseName: undefined },
    ]);
  });
});

describe('classifyEdge', () => {
  test('uses the relationship type when no role derived it', () => {
    for (const type of ['belongs_to', 'has_many', 'has_one'] as const) {
      const edge: Edge = {
        from: 'a',
        to: 'b',
        relationship: relationship({ type }),
        cardinality: 'N:1',
        bidirectional: false,
      };
      expect(classifyEdge(edge)).toBe(type);
    }
  });

  test('a role-derived relationship classifies as a role, not a belongs_to', () => {
    const edge: Edge = {
      from: 'message',
      to: 'person',
      relationship: { ...relationship(), role: 'sender' },
      cardinality: 'N:1',
      bidirectional: false,
    };
    expect(classifyEdge(edge)).toBe('role');
  });

  test('an empty role string is not a role', () => {
    const edge: Edge = {
      from: 'a',
      to: 'b',
      relationship: { ...relationship(), role: '' },
      cardinality: 'N:1',
      bidirectional: false,
    };
    expect(classifyEdge(edge)).toBe('belongs_to');
  });
});

describe('buildEdges', () => {
  test('labels a role edge with the role name and keeps it on the edge', () => {
    const edges = buildEdges(
      graph({
        edges: [
          {
            from: 'message',
            to: 'person',
            relationship: { ...relationship({ name: 'sender_person' }), role: 'sender' },
            cardinality: 'N:1',
            bidirectional: false,
          },
        ],
      }),
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      studioKind: 'role',
      roleName: 'sender',
      label: 'sender',
      type: 'fk',
      source: 'message',
      target: 'person',
    });
  });

  test('a junction becomes a node with an edge in and an edge out', () => {
    const edges = buildEdges(
      graph({
        relationshipDefinitions: { person_org: relDef('person_org', 'person', 'organization') },
      }),
    );

    expect(edges.map((e) => [e.source, e.target, e.studioKind, e.cardinality])).toEqual([
      ['person', 'person_org', 'junction', '1:N'],
      ['person_org', 'organization', 'junction', 'N:1'],
    ]);
  });

  test('an N:M edge through a known junction is not drawn twice', () => {
    const edges = buildEdges(
      graph({
        relationshipDefinitions: { person_org: relDef('person_org', 'person', 'organization') },
        edges: [
          {
            from: 'person',
            to: 'organization',
            relationship: relationship({ name: 'person_org', type: 'has_many' }),
            cardinality: 'N:M',
            bidirectional: true,
          },
        ],
      }),
    );

    // Only the junction pair; the N:M edge it duplicates is dropped.
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.studioKind === 'junction')).toBe(true);
  });

  test('an N:M edge with no matching junction is kept', () => {
    const edges = buildEdges(
      graph({
        edges: [
          {
            from: 'person',
            to: 'organization',
            relationship: relationship({ name: 'orphan', type: 'has_many' }),
            cardinality: 'N:M',
            bidirectional: true,
          },
        ],
      }),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]!.studioKind).toBe('has_many');
  });

  test('identical edges declared from both sides collapse to one stroke', () => {
    const edge: Edge = {
      from: 'a',
      to: 'b',
      relationship: relationship({ name: 'rel' }),
      cardinality: 'N:1',
      bidirectional: false,
    };
    expect(buildEdges(graph({ edges: [edge, { ...edge }] }))).toHaveLength(1);
  });
});

describe('adaptDomainGraph', () => {
  test('produces one node per entity and per junction', () => {
    const result = adaptDomainGraph(
      graph({
        entities: { person: entity('person'), organization: entity('organization') },
        relationshipDefinitions: { person_org: relDef('person_org', 'person', 'organization') },
        edges: [],
      }),
    );

    expect(result.nodes.map((n) => n.id)).toEqual(['person', 'organization', 'person_org']);
    expect(result.nodes.filter((n) => n.kind === 'relationship')).toHaveLength(1);
    expect(result.edges).toHaveLength(2);
  });

  test('an empty graph adapts to an empty canvas rather than throwing', () => {
    expect(adaptDomainGraph(graph())).toEqual({ nodes: [], edges: [] });
  });
});

describe('the canvas counts differently from the API, on purpose', () => {
  // A first-class relationship is ONE `N:M` entry in `graph.edges`, but a node
  // plus two edges on the canvas — it carries its own fields, types and
  // temporal/sourced flags, and a line has nowhere to put them. Comparing the
  // two numbers and "fixing" the difference would break the canvas, so the
  // exact counts are pinned here rather than left to be rediscovered.
  const SHAPE = graph({
    entities: {
      account: entity('account'),
      contact: entity('contact'),
      opportunity: entity('opportunity'),
    },
    relationshipDefinitions: {
      contact_opportunity: relDef('contact_opportunity', 'contact', 'opportunity'),
    },
    edges: [
      {
        from: 'contact',
        to: 'account',
        relationship: relationship({ name: 'account' }),
        cardinality: 'N:1',
        bidirectional: false,
      },
      {
        from: 'account',
        to: 'contact',
        relationship: relationship({ name: 'contacts', type: 'has_many' }),
        cardinality: '1:N',
        bidirectional: false,
      },
      {
        from: 'opportunity',
        to: 'account',
        relationship: relationship({ name: 'account' }),
        cardinality: 'N:1',
        bidirectional: false,
      },
      {
        from: 'account',
        to: 'opportunity',
        relationship: relationship({ name: 'opportunities', type: 'has_many' }),
        cardinality: '1:N',
        bidirectional: false,
      },
      // The API's single entry for the junction.
      {
        from: 'contact',
        to: 'opportunity',
        relationship: relationship({ name: 'contact_opportunity', type: 'has_many' }),
        cardinality: 'N:M',
        bidirectional: true,
      },
    ],
  });

  test('3 entities and 5 API edges draw as 4 nodes and 6 edges', () => {
    const { nodes, edges } = adaptDomainGraph(SHAPE);
    expect(Object.keys(SHAPE.entities)).toHaveLength(3);
    expect(SHAPE.edges).toHaveLength(5);
    expect(nodes).toHaveLength(4);
    expect(edges).toHaveLength(6);
  });

  test('the extra node is the relationship, and it is not an entity', () => {
    const { nodes } = adaptDomainGraph(SHAPE);
    const junction = nodes.find((n) => n.kind === 'relationship');
    expect(junction?.id).toBe('contact_opportunity');
    expect(nodes.filter((n) => n.kind === 'entity')).toHaveLength(3);
  });

  test('the junction is reached by two edges, not one', () => {
    const { edges } = adaptDomainGraph(SHAPE);
    const touching = edges.filter(
      (e) => e.source === 'contact_opportunity' || e.target === 'contact_opportunity',
    );
    expect(touching).toHaveLength(2);
    expect(touching.every((e) => e.studioKind === 'junction')).toBe(true);
    // …and the API's own N:M entry is not additionally drawn between the two
    // endpoints, which would show the same association twice.
    expect(edges.some((e) => e.source === 'contact' && e.target === 'opportunity')).toBe(false);
  });
});
