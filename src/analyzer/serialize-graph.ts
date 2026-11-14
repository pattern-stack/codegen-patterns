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
  pattern?: string;
  patterns?: string[];
  patternConfig?: Record<string, unknown>;
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
  /** CAP-2 — set when this relationship was derived from a `roles:` entry. */
  role?: string;
  /** The parsed `on_delete:` (ADR-021); `restrict` by default. Absent on a junction's synthesized edge. */
  onDelete?: 'restrict' | 'cascade' | 'set_null' | 'no_action';
  /**
   * On a `belongs_to` only: its FK column is unique — the field says
   * `unique: true`, or a `unique_indexes:` entry lists that column and nothing
   * else. A composite entry does not make the column unique; the tenant column
   * a `tenant_scoped` entity prefixes onto every unique does not change the
   * answer (unique per tenant is still one row per parent). See `fkColumnUnique`.
   */
  fkUnique?: boolean;
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

/**
 * One relationship, serialized. The entity map and the edge list both go
 * through this — they used to carry separate field-by-field copies, and the
 * edge copy silently dropped `role` (#698).
 */
function serializeRelationship(
  r: ParsedRelationship,
  holder: ParsedEntity | undefined,
): SerializedRelationship {
  return {
    name: r.name,
    type: r.type,
    target: r.target,
    foreignKey: r.foreignKey,
    inverse: r.inverse,
    through: r.through,
    resolved: r.resolved,
    role: r.role,
    onDelete: r.onDelete,
    ...(r.type === 'belongs_to' && holder !== undefined
      ? { fkUnique: fkColumnUnique(holder, r.foreignKey) }
      : {}),
  };
}

/**
 * Whether `column` on `entity` is unique: its field declares `unique: true`, or
 * a `unique_indexes:` entry lists it alone.
 *
 * **A temporary duplicate.** The generator decides the same thing where it
 * emits the constraints — `fieldUniqueEntries` + `processUniqueIndexes` in
 * `templates/entity/new/backend/entity-locals.js`, over the raw YAML — and no
 * function under `src/` owns the rule yet. Until one does, the parity test
 * (`src/__tests__/analyzer/serialize-graph-fk-unique-parity.test.ts`) holds
 * this copy equal to what the generator emits.
 */
export function fkColumnUnique(entity: ParsedEntity, column: string): boolean {
  if (entity.fields.get(column)?.unique === true) return true;
  return entity.uniqueIndexes.some((ui) => ui.fields.length === 1 && ui.fields[0] === column);
}

function serializeRelationships(entity: ParsedEntity): Record<string, SerializedRelationship> {
  const result: Record<string, SerializedRelationship> = {};
  for (const [key, r] of entity.relationships) {
    result[key] = serializeRelationship(r, entity);
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
      pattern: entity.pattern,
      patterns: entity.patterns,
      patternConfig: entity.patternConfig,
      fields: serializeFields(entity.fields),
      relationships: serializeRelationships(entity),
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
      relationship: serializeRelationship(e.relationship, graph.entities.get(e.from)),
      cardinality: e.cardinality,
      bidirectional: e.bidirectional,
    })),
  };
}
