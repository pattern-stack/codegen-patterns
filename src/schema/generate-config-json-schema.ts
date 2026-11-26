#!/usr/bin/env bun
/**
 * Write `src/schema/codegen-config.schema.json` from the config's Zod schema (TGT-0b).
 *
 * Usage: `just gen-config-schema` (or `bun src/schema/generate-config-json-schema.ts`). Run it after changing any
 * block in `codegen-config.schema.ts` or a row of `TARGET_PAIRS`; `codegen-config-json-schema.test.ts` fails until
 * the committed file matches.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderCodegenConfigJsonSchema } from './codegen-config.json-schema.js';

const outputPath = fileURLToPath(new URL('./codegen-config.schema.json', import.meta.url));
writeFileSync(outputPath, renderCodegenConfigJsonSchema());
console.log(`Wrote ${outputPath}`);
