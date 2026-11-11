/**
 * Smoke scan for #796: every generated `timestamp(...)` column call is a
 * timestamptz call, except the `timezone: false` opt-outs the fixture YAML
 * declares — on a field, or on a timestamp behavior (`options: { timezone:
 * false }`, or the project's `behaviors.timezone: false`; #845).
 *
 * Fails closed (CLAUDE.md gate rule (c)): an unparseable `timestamp(` occurrence,
 * an empty scan and an unseen opt-out all throw. The opt-out set comes from the
 * fixture YAML, not from the emitted file (charter I1).
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { sqlTableName } from '../../src/config/table-naming';
import { getBehavior, normalizeBehaviorConfig, timestampBehaviorNames } from '../../src/behaviors/index';
import { resolveImpliedBehaviors } from '../../src/patterns/implied-behaviors';
import { behaviorWithTimezone } from '../../src/schema/field-timestamp';

/**
 * The `behaviors.timezone` every smoke project is generated with: none of them
 * writes a `behaviors:` block, so it is the schema default. A smoke that sets
 * the block must pass its own value — the scan then fails closed on any column
 * the two disagree about.
 */
export const SMOKE_BEHAVIORS_TIMEZONE = true;

const TZ_CALL = /^timestamp\('([a-z0-9_]+)', \{ withTimezone: true, mode: 'date' \}\)/;
const BARE_CALL = /^timestamp\('([a-z0-9_]+)'\)/;

/**
 * The columns of the entity's timestamp behaviors (declared, or implied by its
 * pattern) that are emitted without time zone — by the same rule the generator
 * reads (`behaviorWithTimezone`), with the column names from the behavior
 * registry.
 */
function behaviorOptOutColumns(doc: any, projectBehaviorsTimezone: boolean): string[] {
	if (!doc.entity) return [];
	const declared = (doc.behaviors ?? []) as Parameters<typeof normalizeBehaviorConfig>[0][];
	const names = new Set([
		...declared.map((b) => normalizeBehaviorConfig(b).name),
		...resolveImpliedBehaviors(doc.entity),
	]);
	const cols: string[] = [];
	for (const name of timestampBehaviorNames()) {
		if (!names.has(name) || behaviorWithTimezone(declared, name, projectBehaviorsTimezone)) continue;
		for (const f of getBehavior(name)?.fields ?? []) if (f.type === 'datetime') cols.push(f.name);
	}
	return cols;
}

/**
 * `<table>.<column>` for every column the fixture YAMLs declare without time
 * zone: a `timezone: false` field, or a timestamp behavior switched off. An
 * entity's table is its SQL name — the one rule, `sqlTableName` (TABLE-0) —
 * under the smoke project's `tables.prefix`, which the caller states.
 * `projectBehaviorsTimezone` is the generated project's `behaviors.timezone` —
 * required, so a caller states what its project was generated with.
 */
export function collectTimezoneOptOuts(
	yamlFiles: string[],
	tablePrefix: string,
	projectBehaviorsTimezone: boolean,
): Set<string> {
	const out = new Set<string>();
	for (const file of yamlFiles) {
		const doc = yaml.parse(fs.readFileSync(file, 'utf8')) ?? {};
		const optOutFields = [
			...Object.entries(doc.fields ?? {})
				.filter(([, f]) => (f as { timezone?: unknown } | null)?.timezone === false)
				.map(([name]) => name),
			...behaviorOptOutColumns(doc, projectBehaviorsTimezone),
		];
		if (optOutFields.length === 0) continue;
		const table = doc.entity
			? sqlTableName(doc.entity, tablePrefix)
			: doc.relationship
				? doc.relationship.table
				: undefined;
		if (!table) {
			throw new Error(
				`${file}: declares timezone: false on ${optOutFields.join(', ')} but its table cannot be named; ` +
					'the scan does not guess',
			);
		}
		for (const f of optOutFields) out.add(`${table}.${f}`);
	}
	return out;
}

function entityFiles(dir: string): string[] {
	const files: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) files.push(...entityFiles(p));
		else if (e.name.endsWith('.entity.ts')) files.push(p);
	}
	return files;
}

/** Scans every `*.entity.ts` under `modulesDir`; see the module comment. */
export function assertTimestampColumns(
	modulesDir: string,
	optOuts: Set<string>,
): { files: number; calls: number } {
	const files = entityFiles(modulesDir);
	if (files.length === 0) throw new Error(`timestamp scan: no *.entity.ts under ${modulesDir}`);
	const seenOptOuts = new Set<string>();
	let calls = 0;
	for (const file of files) {
		const src = fs.readFileSync(file, 'utf8');
		// Only the pgTable body names a table; an entity file can declare enums before it.
		const tableName = (idx: number): string => {
			const before = src.slice(0, idx);
			const m = [...before.matchAll(/pgTable\(\s*'([a-z0-9_]+)'/g)].pop();
			return m ? m[1] : '?';
		};
		for (const m of src.matchAll(/(?<![A-Za-z0-9_])timestamp\(/g)) {
			if (/^import\b/.test(src.slice(src.lastIndexOf('\n', m.index) + 1, m.index))) continue;
			const rest = src.slice(m.index);
			const tz = TZ_CALL.exec(rest);
			const bare = BARE_CALL.exec(rest);
			const table = tableName(m.index);
			if (tz) {
				calls++;
				if (optOuts.has(`${table}.${tz[1]}`)) {
					throw new Error(`${file}: ${table}.${tz[1]} declares timezone: false but was emitted with time zone`);
				}
			} else if (bare) {
				calls++;
				const key = `${table}.${bare[1]}`;
				if (!optOuts.has(key)) {
					throw new Error(`${file}: ${key} is a bare timestamp (without time zone) and no fixture declares timezone: false`);
				}
				seenOptOuts.add(key);
			} else {
				throw new Error(`${file}: table ${table}: unrecognised timestamp call: ${rest.slice(0, 80).split('\n')[0]}`);
			}
		}
	}
	if (calls === 0) throw new Error(`timestamp scan: no timestamp( call under ${modulesDir}`);
	for (const o of optOuts) {
		if (!seenOptOuts.has(o)) throw new Error(`timestamp scan: declared opt-out ${o} was never emitted bare`);
	}
	return { files: files.length, calls };
}
