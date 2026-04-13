#!/usr/bin/env bun
/**
 * Generate JSON Schema from Zod schema for YAML editor autocomplete
 *
 * Usage: bun tools/codegen/schema/generate-json-schema.ts
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";

// Define schema for JSON schema generation
const FieldTypeSchema = z.enum([
  "string", "integer", "decimal", "boolean", "uuid",
  "date", "datetime", "json", "entity_ref", "string_array", "enum",
]);

const UiTypeSchema = z.enum([
  "text", "textarea", "number", "money", "percentage",
  "email", "url", "date", "datetime", "boolean",
  "enum", "reference", "json", "badge", "password",
]);

const UiImportanceSchema = z.enum(["primary", "secondary", "tertiary"]);

const FieldDefinitionSchema = z.object({
  type: FieldTypeSchema.describe("Field data type"),
  required: z.boolean().optional().describe("Field must be provided on CREATE"),
  nullable: z.boolean().optional().describe("Database column allows NULL"),
  max_length: z.number().int().positive().optional().describe("Max string length"),
  min_length: z.number().int().nonnegative().optional().describe("Min string length"),
  min: z.number().optional().describe("Minimum numeric value"),
  max: z.number().optional().describe("Maximum numeric value"),
  choices: z.array(z.string()).optional().describe("Enum values for this field"),
  choices_from: z.string().optional().describe("Load enum values from external YAML file"),
  allowed_types: z.array(z.string()).optional().describe("Allowed entity types for entity_ref"),
  default: z.unknown().optional().describe("Default value"),
  index: z.boolean().optional().describe("Create database index"),
  unique: z.boolean().optional().describe("Unique constraint"),
  foreign_key: z.string().optional().describe("Foreign key reference (e.g., 'accounts.id')"),
  ui_label: z.string().optional().describe("Display label"),
  ui_type: UiTypeSchema.optional().describe("UI input type"),
  ui_importance: UiImportanceSchema.optional().describe("Field importance for display"),
  ui_group: z.string().optional().describe("UI grouping"),
  ui_sortable: z.boolean().optional().describe("Allow sorting by this field"),
  ui_filterable: z.boolean().optional().describe("Allow filtering by this field"),
  ui_visible: z.boolean().optional().describe("Show in UI by default"),
  ui_placeholder: z.string().optional().describe("Input placeholder text"),
  ui_help: z.string().optional().describe("Help text"),
});

const RelationshipSchema = z.object({
  type: z.enum(["belongs_to", "has_many", "has_one"]).describe("Relationship type"),
  target: z.string().describe("Target entity name (e.g., 'account')"),
  foreign_key: z.string().describe("FK field name (e.g., 'account_id')"),
});

const BehaviorSchema = z.union([
  z.literal("timestamps").describe("Adds created_at, updated_at"),
  z.literal("soft_delete").describe("Adds deleted_at for soft deletes"),
  z.literal("user_tracking").describe("Adds created_by, updated_by"),
  z.literal("temporal_validity").describe("Adds valid_from, valid_to, is_active"),
  z.object({
    name: z.string().describe("Behavior name"),
    options: z.record(z.string(), z.unknown()).optional().describe("Behavior options"),
  }),
]);

const EntityConfigSchema = z.object({
  name: z.string().describe("Entity name in snake_case (e.g., 'opportunity')"),
  plural: z.string().describe("Plural form in snake_case (e.g., 'opportunities')"),
  table: z.string().describe("Database table name"),
  folder_structure: z.enum(["nested", "flat"]).optional().describe(
    "Directory structure: nested (domain/entity/) or flat (domain/)"
  ),
  file_grouping: z.enum(["separate", "grouped"]).optional().describe(
    "File organization: separate (entity.ts, repository.ts) or grouped (index.ts)"
  ),
  behavior_strategy: z.enum(["base_class", "inline"]).optional().describe(
    "Repository pattern: base_class (DRY) or inline (explicit)"
  ),
  expose: z.array(z.enum(["repository", "rest", "trpc"])).optional().describe(
    "Which layers to generate"
  ),
});

const EntityDefinitionSchema = z.object({
  entity: EntityConfigSchema.describe("Entity configuration"),
  fields: z.record(z.string(), FieldDefinitionSchema).describe("Field definitions"),
  relationships: z.record(z.string(), RelationshipSchema).optional().describe("Entity relationships"),
  behaviors: z.array(BehaviorSchema).optional().describe("Cross-cutting behaviors"),
});

// Generate using Zod v4's native JSON schema support
const jsonSchema = z.toJSONSchema(EntityDefinitionSchema, {
  unrepresentable: "any",
  io: "input",
});

// Add metadata
const schemaWithMeta = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Entity Definition",
  description: "Schema for entity YAML definitions. Defines domain entities with fields, relationships, behaviors, and layout options.",
  ...jsonSchema,
};

const outputPath = resolve(dirname(import.meta.path), "entity-definition.schema.json");
writeFileSync(outputPath, JSON.stringify(schemaWithMeta, null, 2));

console.log(`✅ Generated JSON schema: ${outputPath}`);
console.log(`
To enable autocomplete in entity YAML files, VS Code settings are configured at:
  .vscode/settings.json

The schema will automatically apply to files matching: entities/**/*.yaml
`);
