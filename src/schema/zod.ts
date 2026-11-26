/**
 * Codegen's Zod (ZOD-0): every schema codegen owns imports `z` from here, never from a package.
 *
 * - **Zod 4**, from the `zod4` dependency (an npm alias of `zod@4`). The `zod` dependency stays Zod 3 for the code
 *   emitted apps import (`runtime/`, `templates/`) and for consumers' own pattern schemas; it moves in ZOD-0 step 2,
 *   a major, after which this file imports `zod` and nothing else changes.
 * - **One message rule on top of Zod's**: an enum refusal names the value it refused. Zod 4 says
 *   `Invalid option: expected one of "string"|"integer"|…`; codegen adds `, received "strng"`, so a typo is visible
 *   in the CLI's one-line error and in Studio's marker. Every other message is Zod's own wording, or codegen's
 *   `message:` text.
 *
 * The rule is installed with `z.config`, which is global to this copy of Zod — the `zod4` alias only codegen
 * imports — so it reaches no consumer schema.
 */

import { z } from 'zod4';

const english = z.locales.en().localeError;

z.config({
	customError: (issue) => {
		if (issue.code !== 'invalid_value' || issue.values.length < 2) return undefined;
		const message = english?.(issue);
		const base = typeof message === 'string' ? message : message?.message;
		return base === undefined ? undefined : `${base}, received ${JSON.stringify(issue.input)}`;
	},
});

export { z };
