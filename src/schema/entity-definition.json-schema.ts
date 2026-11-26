/**
 * Entity YAML as a JSON Schema, for editor completion and checking (ZOD-0, #696).
 *
 * DERIVED from {@link EntityDefinitionSchema}, never hand-kept. Until ZOD-0 the entity schema was restated by hand on
 * Zod 4 just to reach `z.toJSONSchema`, because the real one was Zod 3; it drifted (ARCH-1 had to hand-edit the JSON,
 * #696) and covered seven of the entity's keys. `src/schema/entity-definition.schema.json` is this function's output,
 * written by `generate-entity-json-schema.ts` (`just gen-entity-schema`); a unit test fails when the committed file and
 * a fresh build differ.
 *
 * `detection:` values are the runtime's Zod 3 schema, hosted through `fromZod3`: the editor sees their top-level keys
 * and `mode` values (read from that schema), and the generator's own parse checks the rest.
 */

import { EntityDefinitionSchema } from './entity-definition.schema.js';
import { editorJsonSchema } from './editor-json-schema.js';

/** The JSON Schema for an entity YAML. Pure: the same object for the same Zod schema. */
export function buildEntityDefinitionJsonSchema(): Record<string, unknown> {
	return editorJsonSchema(EntityDefinitionSchema, {
		title: 'Entity Definition',
		description:
			'Schema for entity YAML definitions. Generated from src/schema/entity-definition.schema.ts; do not edit.',
	});
}

/** The committed file's text: the schema, two-space indented, with a trailing newline. */
export function renderEntityDefinitionJsonSchema(): string {
	return `${JSON.stringify(buildEntityDefinitionJsonSchema(), null, 2)}\n`;
}
