/**
 * Serialization helpers for DomainGraph.
 *
 * DomainGraph uses Map<string, T> for entities, fields, and relationships.
 * JSON.stringify doesn't serialize Maps, so we convert them to Records first.
 *
 * This module is intended to be imported by the CLI command, not the viewer.
 * It's co-located here because it produces the SerializedDomainGraph type
 * that the SchemaAdapter consumes.
 */
import type { SerializedDomainGraph, SerializedEntity, SerializedRelationshipDefinition, SerializedField } from './schema-adapter';

interface DomainGraphLike {
  entities: Map<string, EntityLike>;
  relationshipDefinitions: Map<string, RelDefLike>;
  edges: EdgeLike[];
}

interface EntityLike {
  name: string;
  plural: string;
  table: string;
  family?: string;
  fields: Map<string, FieldLike>;
  relationships: Map<string, RelLike>;
  behaviors: string[];
  queries?: QueryLike[];
  sourcePath: string;
}

interface FieldLike {
  name: string;
  type: string;
  required: boolean;
  nullable: boolean;
  unique: boolean;
  index: boolean;
  foreignKey?: { table: string; column: string };
  choices?: string[];
}

interface RelLike {
  name: string;
  type: 'belongs_to' | 'has_many' | 'has_one';
  target: string;
  foreignKey: string;
  inverse?: string;
  through?: string;
  resolved: boolean;
}

interface RelDefLike {
  name: string;
  table: string;
  from: string;
  to: string;
  selfReferential: boolean;
  fromColumn: string;
  toColumn: string;
  types: { name: string; inverse?: string; bidirectional: boolean; directed: boolean }[];
  hasTypes: boolean;
  temporal: boolean;
  sourced: boolean;
  onDeleteFrom: string;
  onDeleteTo: string;
  uniqueOn: string[];
  fields: Map<string, FieldLike>;
  queries?: QueryLike[];
  sourcePath: string;
}

interface QueryLike {
  by: string[];
  unique?: boolean;
  select?: string[];
  order?: string;
  limit?: boolean;
  via?: string;
}

interface EdgeLike {
  from: string;
  to: string;
  relationship: RelLike;
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
  bidirectional: boolean;
}

function serializeFields(fields: Map<string, FieldLike>): Record<string, SerializedField> {
  const result: Record<string, SerializedField> = {};
  for (const [key, f] of fields) {
    result[key] = {
      name: f.name,
      type: f.type,
      required: f.required,
      nullable: f.nullable,
      unique: f.unique,
      index: f.index,
      foreignKey: f.foreignKey,
      choices: f.choices,
    };
  }
  return result;
}

export function serializeDomainGraph(graph: DomainGraphLike): SerializedDomainGraph {
  const entities: Record<string, SerializedEntity> = {};
  for (const [key, entity] of graph.entities) {
    const rels: Record<string, RelLike> = {};
    for (const [rk, rv] of entity.relationships) {
      rels[rk] = rv;
    }
    entities[key] = {
      name: entity.name,
      plural: entity.plural,
      table: entity.table,
      family: entity.family,
      fields: serializeFields(entity.fields),
      relationships: rels,
      behaviors: entity.behaviors,
      queries: entity.queries,
      sourcePath: entity.sourcePath,
    };
  }

  const relationshipDefinitions: Record<string, SerializedRelationshipDefinition> = {};
  for (const [key, relDef] of graph.relationshipDefinitions) {
    relationshipDefinitions[key] = {
      name: relDef.name,
      table: relDef.table,
      from: relDef.from,
      to: relDef.to,
      selfReferential: relDef.selfReferential,
      fromColumn: relDef.fromColumn,
      toColumn: relDef.toColumn,
      types: relDef.types,
      hasTypes: relDef.hasTypes,
      temporal: relDef.temporal,
      sourced: relDef.sourced,
      onDeleteFrom: relDef.onDeleteFrom,
      onDeleteTo: relDef.onDeleteTo,
      uniqueOn: relDef.uniqueOn,
      fields: serializeFields(relDef.fields),
      queries: relDef.queries,
      sourcePath: relDef.sourcePath,
    };
  }

  return {
    entities,
    relationshipDefinitions,
    edges: graph.edges.map((e) => ({
      from: e.from,
      to: e.to,
      relationship: e.relationship,
      cardinality: e.cardinality,
      bidirectional: e.bidirectional,
    })),
  };
}
