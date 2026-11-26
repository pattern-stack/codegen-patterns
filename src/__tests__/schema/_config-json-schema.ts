/**
 * Test helper (TGT-0b): validate a `codegen.config.yaml` value against the COMMITTED JSON Schema, the file an editor
 * reads, with ajv in strict mode (a keyword ajv doesn't know is an error, not ignored).
 */

import Ajv from 'ajv';
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_JSON_SCHEMA_PATH = path.resolve(import.meta.dir, '../../schema/codegen-config.schema.json');

const validate = new Ajv({ allErrors: true, strict: true }).compile(
	JSON.parse(fs.readFileSync(CONFIG_JSON_SCHEMA_PATH, 'utf-8')),
);

/** The JSON Schema's verdict: `[]` when it accepts, else ajv's `instancePath: message` per error. */
export function jsonSchemaErrors(config: unknown): string[] {
	if (validate(config)) return [];
	return (validate.errors ?? []).map((e) => `${e.instancePath || '/'}: ${e.message}`);
}
