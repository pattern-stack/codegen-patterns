/**
 * A Zod schema as the JSON Schema an editor reads (ZOD-0): the one converter behind both committed editor schemas,
 * `codegen-config.schema.json` and `entity-definition.schema.json`.
 *
 * - **Input side** (`io: 'input'`): the file as WRITTEN. A key with a default is optional; a transform contributes its
 *   input, not its output.
 * - **Draft 07**: the draft YAML editors (yaml-language-server) and the tests' `ajv` read without extra setup.
 * - **Inline**: a schema used twice is written out twice rather than as a `$ref`, so each key carries its own
 *   description where the editor shows it. Recursive schemas still use `$ref` (they can't be inlined).
 * - **Editor hints** (`editorHints` in `./zod`) replace what Zod derives for a schema it can't express, such as a
 *   runtime Zod 3 schema hosted through `fromZod3`.
 *
 * Refinements that span keys (`superRefine`) have no JSON Schema form; the generator's own parse still runs them, so
 * the editor is a first check, not the gate.
 */

import { editorHints, z } from './zod';

export function editorJsonSchema(
	schema: z.ZodType,
	header: { title: string; description: string },
): Record<string, unknown> {
	const { $schema, ...body } = z.toJSONSchema(schema, {
		target: 'draft-7',
		io: 'input',
		reused: 'inline',
		override: ({ zodSchema, jsonSchema }) => {
			const hint = editorHints.get(zodSchema);
			if (hint === undefined) return;
			const target = jsonSchema as Record<string, unknown>;
			for (const key of Object.keys(target)) delete target[key];
			Object.assign(target, hint.jsonSchema);
		},
	}) as Record<string, unknown>;
	return { $schema, ...header, ...body };
}
