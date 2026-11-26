/**
 * `codegen.config.yaml` as a JSON Schema, for editor completion and checking (TGT-0b, ADR-047).
 *
 * DERIVED from {@link CodegenConfigObjectSchema}, never hand-kept: `target:` is the union of `TARGET_PAIRS` there,
 * so an editor offers exactly the supported `(database, orm)` pairs and underlines anything else, and every other
 * block's keys, enums and descriptions come along. `src/schema/codegen-config.schema.json` is this function's output,
 * written by `generate-config-json-schema.ts` (`just gen-config-schema`); a unit test fails when the committed file
 * and a fresh build differ, so it cannot drift the way the hand-kept entity schema did (#696).
 *
 * The repo is on Zod 3, whose schemas `z.toJSONSchema` (Zod 4) cannot read, so the converter is `zod-to-json-schema`
 * (a devDependency; the JSON file is what ships). When the repo moves to Zod 4 this becomes `z.toJSONSchema` with
 * `io: 'input'`.
 *
 * The schema describes the file as WRITTEN (Zod's input side): keys with defaults are optional, and the top-level
 * transform that fills `patterns` from `paths` is not in it. Refinements that span keys (`superRefine`) can't be
 * expressed in JSON Schema; the generator's own parse still runs them, so the editor is a first check, not the gate.
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import { CodegenConfigObjectSchema } from './codegen-config.schema.js';

/** The JSON Schema for `codegen.config.yaml`. Pure: the same object for the same Zod schema. */
export function buildCodegenConfigJsonSchema(): Record<string, unknown> {
	const schema = zodToJsonSchema(CodegenConfigObjectSchema, {
		target: 'jsonSchema7',
		$refStrategy: 'none',
		effectStrategy: 'input',
		pipeStrategy: 'input',
	}) as Record<string, unknown>;
	const { $schema, ...body } = schema;
	return {
		$schema,
		$id: 'https://github.com/pattern-stack/codegen-patterns/blob/main/src/schema/codegen-config.schema.json',
		title: 'codegen.config.yaml',
		description:
			'Project configuration for @pattern-stack/codegen. Generated from src/schema/codegen-config.schema.ts; do not edit.',
		...body,
	};
}

/** The committed file's text: the schema, two-space indented, with a trailing newline. */
export function renderCodegenConfigJsonSchema(): string {
	return `${JSON.stringify(buildCodegenConfigJsonSchema(), null, 2)}\n`;
}
