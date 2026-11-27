/**
 * TGT-2b: a storage-only target (`layers: 'storage'` on its TARGET_PAIRS row — SQLite) has no junction or
 * relationship pipeline yet. Both are pg-core text end to end (#679 collapses them; G8 groups modules), so their
 * commands refuse such a target by name instead of writing Postgres text into a SQLite project.
 */

import { configOrDefaults } from '../../config/project-config.js';
import { targetPairRow } from '../../targets/pairs.js';
import type { Context } from './context.js';

/** The refusal message for `command` on a storage-only target, or `null` when the target has every layer. */
export function storageOnlyRefusal(ctx: Context, command: string): string | null {
	const target = configOrDefaults(ctx.config).target;
	if (targetPairRow(target).layers !== 'storage') return null;
	return (
		`${command}: target ${target.database} emits the storage layer only, and the ${command.split(' ')[0]} pipeline ` +
		'writes Postgres (pg-core) tables. It comes to this target with #679 / G8.'
	);
}
