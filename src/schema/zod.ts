/**
 * Codegen's Zod (ZOD-0): every schema codegen owns imports `z` from here, never from a package.
 *
 * - **Zod 4**, from the `zod4` dependency (an npm alias of `zod@4`). The `zod` dependency stays Zod 3 for the code
 *   emitted apps import (`runtime/`, the `.ejs.t` templates) until ZOD-0 step 2 moves it; step 2 then imports `zod`
 *   here, deletes the `zod4` alias, `fromZod3` and the boundary test.
 * - **{@link codegenMessages}**, the one message rule codegen adds to Zod's: an enum refusal names the value it
 *   refused. Zod 4 says `Invalid option: expected one of "string"|"integer"|…`; codegen adds `, received "strng"`, so
 *   a typo is visible in the CLI's one-line error and in Studio's marker. It is passed per parse
 *   (`schema.safeParse(data, { error: codegenMessages })`) where codegen reports issues to an author: the YAML
 *   loaders, the config loader, Studio and the junction prompt. Never `z.config`: Zod 4 keeps that on `globalThis`,
 *   shared by every Zod 4 copy in the process, consumers' pattern schemas included.
 */

import { z } from 'zod4';

const english = z.locales.en().localeError;

/** A refused value as the message quotes it; `undefined` (no suffix) for anything that isn't a plain scalar. */
function quoted(input: unknown): string | undefined {
	if (typeof input === 'string') return JSON.stringify(input);
	if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') return String(input);
	if (input === null) return 'null';
	return undefined;
}

/** Codegen's error map: Zod's English, plus the refused value on an enum refusal. Pass it per parse. */
export const codegenMessages: z.core.$ZodErrorMap = (issue) => {
	if (issue.code !== 'invalid_value' || issue.values.length < 2) return undefined;
	const value = quoted(issue.input);
	const message = english(issue);
	const base = typeof message === 'string' ? message : message?.message;
	return base === undefined || value === undefined ? undefined : `${base}, received ${value}`;
};

/**
 * What an editor should see for a schema whose JSON Schema `z.toJSONSchema` cannot derive, or derives too loosely:
 * `schema.register(editorHints, { jsonSchema })`. Read only by `editorJsonSchema`; the parse never sees it. Each hint
 * is derived from its owner (the behavior registry, a runtime schema), never restated.
 */
export const editorHints = z.registry<{ jsonSchema: Record<string, unknown> }>();

export { z };
