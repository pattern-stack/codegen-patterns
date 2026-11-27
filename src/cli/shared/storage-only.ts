/**
 * TGT-2b: a storage-only target (`layers: 'storage'` on its TARGET_PAIRS row — SQLite) has no junction or
 * relationship pipeline yet. Both are pg-core text end to end (#679 collapses them; G8 groups modules), so their
 * commands refuse such a target by name instead of writing Postgres text into a SQLite project.
 */

import { configOrDefaults } from '../../config/project-config.js';
import { targetPairRow } from '../../targets/pairs.js';
import { isPatternStackWiring } from '../../targets/apps.js';
import type { Context } from './context.js';
import fs from 'node:fs';
import path from 'node:path';
import { relationshipsDirFor } from '../../config/junctions-dir.js';
import { findYamlFiles } from '../../utils/find-yaml-files.js';

/** The refusal message for `command` on a storage-only target, or `null` when the target has every layer. */
export function storageOnlyRefusal(ctx: Context, command: string): string | null {
	const target = configOrDefaults(ctx.config).target;
	if (targetPairRow(target).layers !== 'storage') return null;
	return (
		`${command}: target ${target.database} emits the storage layer only, and the ${command.split(' ')[0]} pipeline ` +
		'writes Postgres (pg-core) tables. It comes to this target with #679 / G8.'
	);
}

/**
 * PW-3a: plain wiring has no relationship pipeline yet — its templates are Nest-decorated end to end (relationships
 * wait for #679; junctions came with PW-3c). `relationship new` refuses a plain target by name, and so does
 * `entity new` when relationship YAMLs exist, instead of writing Nest code into a project that installs none.
 */
export function patternStackWiringRefusal(ctx: Context, command: string): string | null {
	const target = configOrDefaults(ctx.config).target;
	if (!isPatternStackWiring(target)) return null;
	return (
		`${command}: target.wiring is plain, and the ${command.split(' ')[0]} pipeline writes NestJS classes. ` +
		'Relationship definitions come to plain wiring with #679.'
	);
}

/**
 * PW-3a: under plain wiring, a command that writes the schema barrel or the composition (`entity new`, `junction new`)
 * refuses a project with relationship YAMLs, naming them, rather than generating with their tables silently missing
 * from the schema barrel (#679). Null when the target isn't plain or there are none.
 */
export function plainRelationshipYamlsRefusal(ctx: Context, command: string): string | null {
	if (!isPlainWiring(configOrDefaults(ctx.config).target)) return null;
	const dir = relationshipsDirFor(ctx.cwd);
	const pending = (fs.existsSync(dir) ? findYamlFiles(dir) : []).map((f) => path.relative(ctx.cwd, f));
	if (pending.length === 0) return null;
	return (
		`${command}: target.wiring is plain, and these relationship definitions have no plain pipeline yet (#679): ` +
		pending.join(', ')
	);
}
