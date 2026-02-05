import { z } from "zod";

/**
 * Entity Definition Schema
 *
 * Generates backend code:
 * - Domain entity + repository interface
 * - Application DTOs, use-cases, queries
 * - Infrastructure Drizzle schema + repository
 * - Presentation controller
 * - NestJS module wiring
 * - Shared Zod schema in packages/db
 *
 * Generates frontend code:
 * - Entity metadata for automatic admin panels
 * - UI type, importance, grouping for fields
 */

// ============================================================================
// Field Types
// ============================================================================

const FieldTypeSchema = z.enum([
  "string",
  "integer",
  "decimal",
  "boolean",
  "uuid",
  "date",
  "datetime",
  "json",
  "entity_ref", // Polymorphic reference: generates {field}EntityType + {field}EntityId columns
  "string_array", // Array of strings: generates text[] column
  "enum", // Enum type with choices or choices_from
]);

export type FieldType = z.infer<typeof FieldTypeSchema>;

// ============================================================================
// UI Metadata Types
// ============================================================================

const UiTypeSchema = z.enum([
  "text",
  "textarea",
  "number",
  "money",
  "percentage",
  "email",
  "url",
  "date",
  "datetime",
  "boolean",
  "enum",
  "reference",
  "json",
  "badge",
  "password",
]);

export type UiType = z.infer<typeof UiTypeSchema>;

const UiImportanceSchema = z.enum(["primary", "secondary", "tertiary"]);

export type UiImportance = z.infer<typeof UiImportanceSchema>;

/**
 * UI Metadata Schema - Optional field-level UI properties
 *
 * All properties are optional and will be inferred at generation time
 * if not explicitly specified in the YAML definition.
 */
const UiMetadataSchema = z.object({
  ui_label: z.string().optional(),
  ui_type: UiTypeSchema.optional(),
  ui_importance: UiImportanceSchema.optional(),
  ui_group: z.string().optional(),
  ui_sortable: z.boolean().optional(),
  ui_filterable: z.boolean().optional(),
  ui_visible: z.boolean().optional(),
  ui_placeholder: z.string().optional(),
  ui_help: z.string().optional(),
  ui_format: z.record(z.unknown()).optional(),
});

// ============================================================================
// Field Definition
// ============================================================================

/**
 * Field Definition Schema
 *
 * Semantics:
 * - `required: true` → Field must be provided on CREATE (DTO validation)
 * - `required: false` → Field is optional on CREATE (DTO validation)
 * - `nullable: true` → Database column allows NULL
 * - `nullable: false` (default) → Database column is NOT NULL
 *
 * Common patterns:
 * - `required: true` (nullable defaults to false) → Must provide, cannot be null
 * - `required: false, nullable: true` → Optional field, can be null
 * - `required: true, nullable: true` → INVALID (rejected by validator)
 * - `required: false, nullable: false` → Has default value in DB
 */
/**
 * Base Field Schema - Core database/type properties
 */
const BaseFieldSchema = z.object({
  type: FieldTypeSchema,
  required: z.boolean().optional().default(false),
  nullable: z.boolean().optional().default(false),

  // String constraints
  max_length: z.number().int().positive().optional(),
  min_length: z.number().int().nonnegative().optional(),

  // Numeric constraints
  min: z.number().optional(),
  max: z.number().optional(),

  // Enum/choices (inline definition)
  choices: z.array(z.string()).optional(),

  // Enum/choices from external file (e.g., "relationship_types.yaml")
  // Mutually exclusive with choices - parser loads file and extracts keys
  choices_from: z.string().optional(),

  // Entity reference: allowed entity types for polymorphic refs
  // Required when type is 'entity_ref'
  allowed_types: z.array(z.string()).optional(),

  // Default value
  default: z.unknown().optional(),

  // Indexing
  index: z.boolean().optional(),
  unique: z.boolean().optional(),

  // Foreign key reference (e.g., "accounts.id")
  foreign_key: z.string().optional(),
});

/**
 * Field Definition Schema - Combines base fields with optional UI metadata
 */
const FieldDefinitionSchema = BaseFieldSchema.merge(UiMetadataSchema)
  .refine((data) => !(data.required === true && data.nullable === true), {
    message:
      "'required: true' and 'nullable: true' cannot both be set. A required field cannot be null.",
    path: ["required"],
  })
  .refine(
    (data) => {
      if (data.min_length !== undefined && data.type !== "string") {
        return false;
      }
      return true;
    },
    {
      message: "'min_length' can only be used with type 'string'",
      path: ["min_length"],
    },
  )
  .refine(
    (data) => {
      if (data.max_length !== undefined && data.type !== "string") {
        return false;
      }
      return true;
    },
    {
      message: "'max_length' can only be used with type 'string'",
      path: ["max_length"],
    },
  )
  .refine(
    (data) => {
      if (
        data.min !== undefined &&
        !["integer", "decimal"].includes(data.type)
      ) {
        return false;
      }
      return true;
    },
    {
      message: "'min' can only be used with numeric types",
      path: ["min"],
    },
  )
  .refine(
    (data) => {
      if (
        data.max !== undefined &&
        !["integer", "decimal"].includes(data.type)
      ) {
        return false;
      }
      return true;
    },
    {
      message: "'max' can only be used with numeric types",
      path: ["max"],
    },
  )
  .refine(
    (data) => {
      // entity_ref requires allowed_types
      if (data.type === "entity_ref" && !data.allowed_types?.length) {
        return false;
      }
      return true;
    },
    {
      message: "'entity_ref' type requires 'allowed_types' to be specified",
      path: ["allowed_types"],
    },
  )
  .refine(
    (data) => {
      // allowed_types only valid for entity_ref
      if (data.allowed_types !== undefined && data.type !== "entity_ref") {
        return false;
      }
      return true;
    },
    {
      message: "'allowed_types' can only be used with type 'entity_ref'",
      path: ["allowed_types"],
    },
  )
  .refine(
    (data) => {
      // choices and choices_from are mutually exclusive
      if (data.choices !== undefined && data.choices_from !== undefined) {
        return false;
      }
      return true;
    },
    {
      message: "'choices' and 'choices_from' cannot both be specified",
      path: ["choices_from"],
    },
  )
  .refine(
    (data) => {
      // enum type requires either choices or choices_from
      if (data.type === "enum" && !data.choices?.length && !data.choices_from) {
        return false;
      }
      return true;
    },
    {
      message: "'enum' type requires either 'choices' or 'choices_from'",
      path: ["choices"],
    },
  );

export type FieldDefinition = z.infer<typeof FieldDefinitionSchema>;

// ============================================================================
// Relationship Definition
// ============================================================================

const RelationshipTypeSchema = z.enum(["belongs_to", "has_many", "has_one"]);

const RelationshipSchema = z
  .object({
    type: RelationshipTypeSchema,
    target: z.string(), // Target entity name (e.g., "account")
    foreign_key: z.string(), // FK field name (e.g., "account_id")
    through: z.string().optional(), // For transitive: "owned_opportunities.updates"
    inverse: z.string().optional(), // Name of inverse relationship on target entity
  })
  .strict();

export type Relationship = z.infer<typeof RelationshipSchema>;

// ============================================================================
// Behavior Configuration
// ============================================================================

/**
 * Behavior configuration can be:
 * - A simple string: "timestamps"
 * - An object with options: { name: "sluggable", options: { source: "title" } }
 *
 * Built-in behaviors:
 * - timestamps: Adds created_at, updated_at fields
 * - soft_delete: Adds deleted_at field, filters deleted records
 * - user_tracking: Adds created_by, updated_by fields
 * - temporal_validity: Adds valid_from, valid_to, is_active fields
 *   with deactivate() method and validity-aware query filtering
 */
const BehaviorConfigSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    options: z.record(z.unknown()).optional(),
  }),
]);

export type BehaviorConfig = z.infer<typeof BehaviorConfigSchema>;

/**
 * Behavior strategy for repository code generation
 * - base_class: Extend BaseRepository (DRY, recommended)
 * - inline: Generate all code directly (WET, full transparency)
 */
const BehaviorStrategySchema = z.enum(["base_class", "inline"]);

export type BehaviorStrategy = z.infer<typeof BehaviorStrategySchema>;

// ============================================================================
// Entity Configuration
// ============================================================================

/**
 * Layout: Folder structure - controls directory nesting
 * - nested: domain/opportunity/opportunity.entity.ts
 * - flat: domain/opportunity.entity.ts
 */
const FolderStructureSchema = z.enum(["nested", "flat"]).default("nested");

/**
 * Layout: File grouping - controls how related code is organized
 * - separate: Each concern in its own file (entity.ts, repository.interface.ts)
 * - grouped: Related concerns combined into index.ts
 *
 * This is orthogonal to folder_structure:
 * | folder_structure | file_grouping | Result |
 * |-----------------|---------------|--------|
 * | nested | separate | domain/opportunity/opportunity.entity.ts |
 * | nested | grouped  | domain/opportunity/index.ts (combined) |
 * | flat   | separate | domain/opportunity.entity.ts |
 * | flat   | grouped  | domain/opportunity.ts (combined) |
 */
const FileGroupingSchema = z.enum(["separate", "grouped"]).default("separate");

/**
 * Expose configuration - which layers to generate for this entity
 * - repository: Always generated (domain entity, repository interface/impl)
 * - rest: Generate REST controller
 * - trpc: Generate tRPC module
 * - electric: Generate Electric SQL migration (REPLICA IDENTITY + publication)
 *
 * Default: ['repository', 'rest', 'trpc'] (all layers)
 */
const ExposeLayerSchema = z.enum(["repository", "rest", "trpc", "electric"]);
export type ExposeLayer = z.infer<typeof ExposeLayerSchema>;

const EntityConfigSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[a-z][a-z0-9_]*$/,
        "Entity name must be lowercase with underscores (e.g., 'opportunity')",
      ),
    plural: z.string().regex(/^[a-z][a-z0-9_]*$/, "Plural must be lowercase"),
    table: z.string().regex(/^[a-z][a-z0-9_]*$/, "Table must be lowercase"),

    // Layout options (orthogonal concerns)
    // folder_structure: controls directory nesting
    // file_grouping: controls file organization
    folder_structure: FolderStructureSchema.optional(),
    file_grouping: FileGroupingSchema.optional(),

    // Per-entity behavior strategy override (overrides codegen.config.yaml)
    behavior_strategy: BehaviorStrategySchema.optional(),
    // Which layers to generate (default: all)
    expose: z
      .array(ExposeLayerSchema)
      .optional()
      .default(["repository", "rest", "trpc"]),
  })
  .strict();

export type EntityConfig = z.infer<typeof EntityConfigSchema>;

// ============================================================================
// Full Entity Definition
// ============================================================================

export const EntityDefinitionSchema = z
  .object({
    entity: EntityConfigSchema,
    fields: z.record(z.string(), FieldDefinitionSchema),
    relationships: z.record(z.string(), RelationshipSchema).optional(),
    // Behaviors add cross-cutting concerns (timestamps, soft_delete, user_tracking, etc.)
    behaviors: z.array(BehaviorConfigSchema).optional().default([]),
  })
  .strict();

export type EntityDefinition = z.infer<typeof EntityDefinitionSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

export function validateEntityDefinition(data: unknown): EntityDefinition {
  return EntityDefinitionSchema.parse(data);
}

export function safeValidateEntityDefinition(data: unknown): {
  success: boolean;
  data?: EntityDefinition;
  error?: z.ZodError;
} {
  const result = EntityDefinitionSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

// ============================================================================
// Type Mapping Utilities (for code generation)
// ============================================================================

/**
 * Maps YAML field types to TypeScript types
 *
 * Note: 'entity_ref' is handled specially in templates as it generates
 * two fields: {field}EntityType (EntityType enum) and {field}EntityId (string)
 */
export const fieldTypeToTypeScript: Record<FieldType, string> = {
  string: "string",
  integer: "number",
  decimal: "number",
  boolean: "boolean",
  uuid: "string",
  date: "Date",
  datetime: "Date",
  json: "unknown",
  entity_ref: "EntityRef", // Placeholder - templates handle specially
  string_array: "string[]",
  enum: "string", // Actual enum type generated from choices
};

/**
 * Maps YAML field types to Drizzle column types
 *
 * Note: 'entity_ref' generates two columns: pgEnum + uuid
 * Note: 'enum' uses pgEnum with choices
 */
export const fieldTypeToDrizzle: Record<FieldType, string> = {
  string: "varchar",
  integer: "integer",
  decimal: "decimal",
  boolean: "boolean",
  uuid: "uuid",
  date: "date",
  datetime: "timestamp",
  json: "jsonb",
  entity_ref: "entity_ref", // Placeholder - templates handle specially (enum + uuid)
  string_array: "text().array()",
  enum: "enum", // Placeholder - templates generate pgEnum
};

/**
 * Maps YAML field types to Zod schema methods
 *
 * Note: 'entity_ref' generates two fields in Zod schema
 * Note: 'enum' uses z.enum() with choices
 */
export const fieldTypeToZod: Record<FieldType, string> = {
  string: "z.string()",
  integer: "z.number().int()",
  decimal: "z.number()",
  boolean: "z.boolean()",
  uuid: "z.string().uuid()",
  date: "z.date()",
  datetime: "z.date()",
  json: "z.unknown()",
  entity_ref: "entity_ref", // Placeholder - templates handle specially
  string_array: "z.array(z.string())",
  enum: "z.enum()", // Placeholder - templates add choices
};
