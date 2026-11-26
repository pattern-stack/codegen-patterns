#!/usr/bin/env bun
/**
 * Write `src/schema/entity-definition.schema.json` from the entity's Zod schema (ZOD-0, #696).
 *
 * Usage: `just gen-entity-schema` (or `bun src/schema/generate-entity-json-schema.ts`). Run it after changing
 * `entity-definition.schema.ts`; `entity-definition-json-schema.test.ts` fails until the committed file matches.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderEntityDefinitionJsonSchema } from './entity-definition.json-schema.js';

const outputPath = fileURLToPath(new URL('./entity-definition.schema.json', import.meta.url));
writeFileSync(outputPath, renderEntityDefinitionJsonSchema());
console.log(`Wrote ${outputPath}`);
