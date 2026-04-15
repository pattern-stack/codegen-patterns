/**
 * Serializes a DomainGraph to plain JSON (converts Maps to Records).
 *
 * Used by the CLI `codegen project graph` command to produce JSON
 * that the schema-graph-viewer can consume via its SchemaAdapter.
 */
import type {
  DomainGraph,
  ParsedEntity,
  ParsedField,
  ParsedRelationship,
  ParsedRelationshipDefinition,
} from './types';

export interface SerializedDomainGraph {
  entities: Record<string, SerializedEntity>;
  relationshipDefinitions: Record<string, SerializedRelationshipDefinition>;
  edges: SerializedEdge[];
}

export interface SerializedEntity {
  name: string;
  plural: string;
  table: string;
  family?: string;
  fields: Record<string, SerializedField>;
  relationships: Record<string, SerializedRelationship>;
  behaviors: string[];
  queries?: Array<{ by: string[]; unique?: boolean; order?: string }>;
  sourcePath: string;
}

export interface SerializedField {
  name: string;
  type: string;
  required: boolean;
  nullable: boolean;
  unique: boolean;
  index: boolean;
  foreignKey?: { table: string; column: string };
  choices?: string[];
}

export interface SerializedRelationship {
  name: string;
  type: 'belongs_to' | 'has_many' | 'has_one';
  target: string;
  foreignKey: string;
  inverse?: string;
  through?: string;
  resolved: boolean;
}

export interface SerializedRelationshipDefinition {
  name: string;
  table: string;
  from: string;
  to: string;
  selfReferential: boolean;
  fromColumn: string;
  toColumn: string;
  types: Array<{ name: string; inverse?: string; bidirectional: boolean; directed: boolean }>;
  hasTypes: boolean;
  temporal: boolean;
  sourced: boolean;
  onDeleteFrom: string;
  onDeleteTo: string;
  uniqueOn: string[];
  fields: Record<string, SerializedField>;
  queries?: Array<{ by: string[]; unique?: boolean; order?: string }>;
  sourcePath: string;
}

export interface SerializedEdge {
  from: string;
  to: string;
  relationship: SerializedRelationship;
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
  bidirectional: boolean;
}

function serializeFields(fields: Map<string, ParsedField>): Record<string, SerializedField> {
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

function serializeRelationships(
  rels: Map<string, ParsedRelationship>,
): Record<string, SerializedRelationship> {
  const result: Record<string, SerializedRelationship> = {};
  for (const [key, r] of rels) {
    result[key] = {
      name: r.name,
      type: r.type,
      target: r.target,
      foreignKey: r.foreignKey,
      inverse: r.inverse,
      through: r.through,
      resolved: r.resolved,
    };
  }
  return result;
}

/**
 * Convert a DomainGraph (with Maps) to a plain JSON-serializable object.
 */
export function serializeDomainGraph(graph: DomainGraph): SerializedDomainGraph {
  const entities: Record<string, SerializedEntity> = {};
  for (const [key, entity] of graph.entities) {
    entities[key] = {
      name: entity.name,
      plural: entity.plural,
      table: entity.table,
      family: entity.family,
      fields: serializeFields(entity.fields),
      relationships: serializeRelationships(entity.relationships),
      behaviors: entity.behaviors,
      queries: entity.queries?.map((q) => ({
        by: q.by,
        unique: q.unique,
        order: q.order,
      })),
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
      queries: relDef.queries?.map((q) => ({
        by: q.by,
        unique: q.unique,
        order: q.order,
      })),
      sourcePath: relDef.sourcePath,
    };
  }

  return {
    entities,
    relationshipDefinitions,
    edges: graph.edges.map((e) => ({
      from: e.from,
      to: e.to,
      relationship: {
        name: e.relationship.name,
        type: e.relationship.type,
        target: e.relationship.target,
        foreignKey: e.relationship.foreignKey,
        inverse: e.relationship.inverse,
        through: e.relationship.through,
        resolved: e.relationship.resolved,
      },
      cardinality: e.cardinality,
      bidirectional: e.bidirectional,
    })),
  };
}
