/**
 * Column renderers, keyed by the project's data-access target (`target.data` in `codegen.config.yaml`, TGT-0,
 * ADR-047). A renderer turns {@link FieldFacts} into one target's column text.
 *
 * One entry today. The {@link RenderedColumn} shape is what `drizzle-pg` needs and what the templates print; it is
 * not generalised until a second renderer exists and shows what the two share (ADR-047 § One axis at a time).
 *
 * Hygen-safe: reached from `entity-locals.js` and the junction prompt.
 */

import type { FieldFacts } from '../derived/columns/types.js';
import type { DataTarget, TargetConfig } from '../schema/codegen-config.schema.js';
import { drizzlePgColumns } from './drizzle-pg/columns.js';

/** One field's column, as the backend templates print it. */
export interface RenderedColumn {
	/** The builder the column calls (`text`, `varchar`, `enum`, …) — also the key of its import. */
	readonly drizzleType: string;
	/** The full column expression (`varchar('email', { length: 255 }).notNull()`). */
	readonly drizzleChain: string;
	/** The TypeScript type of the column in the select model. */
	readonly tsType: string;
}

export interface ColumnRenderer {
	readonly id: DataTarget;
	render(field: FieldFacts): RenderedColumn;
	/** The module import a column builder (a {@link RenderedColumn.drizzleType}) needs; `undefined` when it needs none. */
	importFor(drizzleType: string): string | undefined;
}

/** Every data-access target's column renderer. Adding a `DataTarget` value without an entry is a type error. */
export const COLUMN_RENDERERS: Readonly<Record<DataTarget, ColumnRenderer>> = {
	'drizzle-pg': drizzlePgColumns,
};

/**
 * The column renderer for the project's resolved `target`. Required: the hygen prompts read `target` from the parsed
 * config, whose schema owns the default, so an absent or unknown value means the caller skipped the prompt — never a
 * reason to fall back to a renderer.
 */
export function columnRendererFor(target: TargetConfig | undefined, caller: string): ColumnRenderer {
	const renderer = target ? COLUMN_RENDERERS[target.data] : undefined;
	if (!renderer) {
		throw new Error(
			`${caller}: target must be the project's resolved \`target\` from codegen.config.yaml ` +
				`(target.data one of ${Object.keys(COLUMN_RENDERERS).join(', ')}); got ${JSON.stringify(target)}.`,
		);
	}
	return renderer;
}
