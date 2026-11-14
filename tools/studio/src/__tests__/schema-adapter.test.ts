/**
 * The graph → canvas adapter. These are the shapes the whole left pane is
 * derived from, so a regression here is a silently wrong picture of the model.
 */
import { describe, expect, test } from 'bun:test';
import type { ProjectApiSurface, SerializedDomainGraph } from '@studio-shared';
import {
  adaptDomainGraph,
  buildEdges,
  classifyEdge,
  entityToNode,
  pascalCase,
  relationshipToNode,
  sourcePathOf,
} from '../adapters/schema-adapter';

import demoSurface from './fixtures/demo-surface-with-relationship.json';

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
      // The derivation keys a role-derived relation `<entity>.roles.<role>`.
      relationId: 'message.roles.sender',
    });
  });

  test('an `inherits:` child draws one 1:1 edge to its base, labelled with its kind value', () => {
    const edges = buildEdges(
      graph({
        entities: {
          communication: entity('communication'),
          meeting: entity('meeting', { inherits: { base: 'communication', as: 'meeting' } }),
        },
      }),
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      id: 'inherits-meeting-communication',
      source: 'meeting',
      target: 'communication',
      studioKind: 'inherits',
      cardinality: '1:1',
      label: 'meeting',
      type: 'fk',
    });
  });

  test('an `inherits:` child is spined under its base, ahead of a belongs_to it also declares, and is never paired', () => {
    const edges = buildEdges(
      graph({
        entities: {
          communication: entity('communication'),
          account: entity('account'),
          meeting: entity('meeting', { inherits: { base: 'communication', as: 'meeting' } }),
        },
        edges: [
          {
            from: 'meeting',
            to: 'account',
            relationship: relationship({ name: 'account', target: 'account', foreignKey: 'account_id', onDelete: 'cascade' }),
            cardinality: 'N:1',
            bidirectional: false,
          },
        ],
      }),
    );

    const inherits = edges.filter((e) => e.studioKind === 'inherits');
    expect(inherits).toHaveLength(1);
    expect(inherits[0]).toMatchObject({ treeRole: 'spine', treeReason: 'spine: inherits' });
    expect(inherits[0]).not.toHaveProperty('inverseRelationId');
    const other = edges.find((e) => e.studioKind === 'belongs_to');
    expect(other?.treeRole).toBe('secondary');
    expect(edges).toHaveLength(2);
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

describe('one line per foreign key (#778)', () => {
  /** `from` belongs_to `to` on `column`. */
  function belongsTo(from: string, name: string, to: string, column: string): Edge {
    return {
      from,
      to,
      relationship: relationship({ name, target: to, foreignKey: column }),
      cardinality: 'N:1',
      bidirectional: true,
    };
  }

  /** `from` has_many (or has_one) `to`, whose `column` points back at `from`. */
  function inverse(from: string, name: string, to: string, column: string, type: 'has_many' | 'has_one' = 'has_many'): Edge {
    return {
      from,
      to,
      relationship: relationship({ name, type, target: to, foreignKey: column }),
      cardinality: type === 'has_many' ? '1:N' : '1:1',
      bidirectional: true,
    };
  }

  test('a belongs_to and its inverse has_many draw as one line', () => {
    const edges = buildEdges(
      graph({
        edges: [
          belongsTo('contact', 'account', 'account', 'account_id'),
          inverse('account', 'contacts', 'contact', 'account_id'),
        ],
      }),
    );

    expect(edges.length, 'expected 1 edge').toBe(1);
    expect(edges[0]).toMatchObject({
      // Drawn as the belongs_to: FK holder → referenced entity.
      source: 'contact',
      target: 'account',
      studioKind: 'belongs_to',
      label: 'account ⇄ contacts',
      relationId: 'contact.relationships.account',
      inverseRelationId: 'account.relationships.contacts',
      parent: 'account',
      child: 'contact',
    });
  });

  test('the order the two halves arrive in does not matter', () => {
    const edges = buildEdges(
      graph({
        edges: [
          inverse('account', 'contacts', 'contact', 'account_id'),
          belongsTo('contact', 'account', 'account', 'account_id'),
        ],
      }),
    );
    expect(edges.length, 'expected 1 edge').toBe(1);
    expect(edges[0]).toMatchObject({ source: 'contact', target: 'account', label: 'account ⇄ contacts' });
  });

  test('a has_one inverse pairs the same way', () => {
    const edges = buildEdges(
      graph({
        edges: [
          belongsTo('profile', 'owner', 'member', 'owner_id'),
          inverse('member', 'profile', 'profile', 'owner_id', 'has_one'),
        ],
      }),
    );
    expect(edges.length, 'expected 1 edge').toBe(1);
    expect(edges[0]).toMatchObject({ label: 'owner ⇄ profile', inverseRelationId: 'member.relationships.profile' });
  });

  test('two foreign keys onto one table stay two lines, each with its own inverse', () => {
    // Paired on the column, not on the entity pair: both FKs join the same two
    // entities, and an entity-pair key would merge them or mis-pair them.
    const edges = buildEdges(
      graph({
        edges: [
          belongsTo('order', 'billing_address', 'address', 'billing_address_id'),
          belongsTo('order', 'shipping_address', 'address', 'shipping_address_id'),
          inverse('address', 'shipped_orders', 'order', 'shipping_address_id'),
          inverse('address', 'billed_orders', 'order', 'billing_address_id'),
        ],
      }),
    );

    expect(edges.length, 'expected 2 edges').toBe(2);
    expect(edges.map((e) => [e.label, e.relationId, e.inverseRelationId])).toEqual([
      ['billing_address ⇄ billed_orders', 'order.relationships.billing_address', 'address.relationships.billed_orders'],
      ['shipping_address ⇄ shipped_orders', 'order.relationships.shipping_address', 'address.relationships.shipped_orders'],
    ]);
  });

  test('a has_many with no matching belongs_to still draws, pointing parent → child', () => {
    const edges = buildEdges(graph({ edges: [inverse('account', 'contacts', 'contact', 'account_id')] }));

    expect(edges.length, 'expected 1 edge').toBe(1);
    expect(edges[0]).toMatchObject({
      source: 'account',
      target: 'contact',
      studioKind: 'has_many',
      label: 'contacts',
      relationId: 'account.relationships.contacts',
      parent: 'account',
      child: 'contact',
    });
    expect(edges[0]!.inverseRelationId).toBeUndefined();
  });

  test('a has_many on a different column between the same two entities is not absorbed', () => {
    const edges = buildEdges(
      graph({
        edges: [
          belongsTo('contact', 'account', 'account', 'account_id'),
          inverse('account', 'referrals', 'contact', 'referred_by_account_id'),
        ],
      }),
    );
    expect(edges.map((e) => [e.studioKind, e.label])).toEqual([
      ['belongs_to', 'account'],
      ['has_many', 'referrals'],
    ]);
  });

  test('a role-derived foreign key pairs with its inverse and keeps the role label', () => {
    const edges = buildEdges(
      graph({
        edges: [
          { ...belongsTo('message', 'sender', 'person', 'sender_id'), relationship: { ...relationship({ name: 'sender', target: 'person', foreignKey: 'sender_id' }), role: 'sender' } },
          inverse('person', 'sent_messages', 'message', 'sender_id'),
        ],
      }),
    );
    expect(edges.length, 'expected 1 edge').toBe(1);
    expect(edges[0]).toMatchObject({
      studioKind: 'role',
      label: 'sender ⇄ sent_messages',
      relationId: 'message.roles.sender',
      inverseRelationId: 'person.relationships.sent_messages',
    });
  });

  test('a self-referential foreign key and its inverse are one line from the entity to itself', () => {
    const edges = buildEdges(
      graph({
        edges: [
          belongsTo('category', 'parent', 'category', 'parent_id'),
          inverse('category', 'children', 'category', 'parent_id'),
        ],
      }),
    );
    expect(edges.length, 'expected 1 edge').toBe(1);
    expect(edges[0]).toMatchObject({ source: 'category', target: 'category', label: 'parent ⇄ children' });
  });

  test('junction halves rank the junction below both of its ends', () => {
    const edges = buildEdges(
      graph({ relationshipDefinitions: { person_org: relDef('person_org', 'person', 'organization') } }),
    );
    expect(edges.map((e) => [e.parent, e.child])).toEqual([
      ['person', 'person_org'],
      ['organization', 'person_org'],
    ]);
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
  // temporal/sourced flags, and a line has nowhere to put them. And a
  // `belongs_to` with its inverse `has_many` is TWO entries in `graph.edges`
  // but one line on the canvas (#778). Comparing the two numbers and "fixing"
  // the difference would break the canvas, so the exact counts are pinned here
  // rather than left to be rediscovered.
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

  test('3 entities and 5 API edges draw as 4 nodes and 4 edges', () => {
    // Was 6 edges until #778: each `belongs_to` and its inverse `has_many` drew
    // as two lines. They are one foreign key, so they now draw as one — the two
    // inline pairs are 2 lines, plus the junction's 2 halves.
    const { nodes, edges } = adaptDomainGraph(SHAPE);
    expect(Object.keys(SHAPE.entities)).toHaveLength(3);
    expect(SHAPE.edges).toHaveLength(5);
    expect(nodes).toHaveLength(4);
    expect(edges).toHaveLength(4);
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

  test('each inline edge carries its relation id; a junction half carries none', () => {
    // Since #778 a paired line carries its `belongs_to`'s id and its inverse's
    // as `inverseRelationId` — every relation is still on exactly one line.
    const { edges } = adaptDomainGraph(SHAPE);
    expect(edges.map((e) => [e.source, e.target, e.relationId, e.inverseRelationId])).toEqual([
      ['contact', 'account', 'contact.relationships.account', 'account.relationships.contacts'],
      ['opportunity', 'account', 'opportunity.relationships.account', 'account.relationships.opportunities'],
      ['contact', 'contact_opportunity', undefined, undefined],
      ['contact_opportunity', 'opportunity', undefined, undefined],
    ]);
  });

  test("every inline edge's relation id is a relation the demo's derived surface lists", () => {
    // The real `project surface --json` of this same shape: the edge panel
    // looks each line's methods up by exactly these keys.
    const surface = demoSurface.surface as ProjectApiSurface;
    const { edges } = adaptDomainGraph(SHAPE);
    // A paired line (#778) draws two relations: its own and its inverse.
    const ids = edges.flatMap((e) => [e.relationId, e.inverseRelationId].filter((id) => id != null)).sort();
    expect(ids).toEqual(surface.relations.map((r) => r.id).sort());
  });
});

describe('buildEdges — spine and secondary lines (STUDIO-3)', () => {
  /**
   * The owner's shape: a child that `belongs_to` parent A through a unique FK
   * with cascade, and `belongs_to` parent B plainly — B declared first, so
   * only the signals can pick A.
   */
  const OWNER_SHAPE = graph({
    entities: { child: entity('child'), parent_a: entity('parent_a'), parent_b: entity('parent_b') },
    edges: [
      {
        from: 'child',
        to: 'parent_b',
        relationship: relationship({ name: 'parent_b', target: 'parent_b', foreignKey: 'parent_b_id', onDelete: 'restrict', fkUnique: false }),
        cardinality: 'N:1',
        bidirectional: false,
      },
      {
        from: 'child',
        to: 'parent_a',
        relationship: relationship({ name: 'parent_a', target: 'parent_a', foreignKey: 'parent_a_id', onDelete: 'cascade', fkUnique: true }),
        cardinality: 'N:1',
        bidirectional: false,
      },
    ],
  });

  test('picks the unique-FK parent as the spine, and says why on the line', () => {
    const edges = buildEdges(OWNER_SHAPE);
    expect(edges.map((e) => [e.target, e.treeRole, e.treeReason])).toEqual([
      ['parent_b', 'secondary', "secondary: child's spine is parent_a (unique FK (1:1))"],
      ['parent_a', 'spine', 'spine: unique FK (1:1)'],
    ]);
  });

  test('a junction hangs under its `from` end; its `to` half is secondary', () => {
    const edges = buildEdges(
      graph({
        entities: { member: entity('member'), skill: entity('skill') },
        relationshipDefinitions: { member_skill: relDef('member_skill', 'member', 'skill') },
      }),
    );
    expect(edges.map((e) => [e.source, e.target, e.treeRole, e.treeReason])).toEqual([
      ['member', 'member_skill', 'spine', 'spine: first declared'],
      ['member_skill', 'skill', 'secondary', "secondary: member_skill's spine is member (first declared)"],
    ]);
  });

  test('an unpaired inverse is never a spine — the holder declared no belongs_to', () => {
    const edges = buildEdges(
      graph({
        entities: { owner: entity('owner'), item: entity('item') },
        edges: [
          {
            from: 'owner',
            to: 'item',
            relationship: relationship({ name: 'items', type: 'has_many', target: 'item', foreignKey: 'owner_id' }),
            cardinality: '1:N',
            bidirectional: false,
          },
        ],
      }),
    );
    expect(edges.map((e) => [e.treeRole, e.treeReason])).toEqual([['secondary', 'secondary: item has no spine']]);
  });
});
