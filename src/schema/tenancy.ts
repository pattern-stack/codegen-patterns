/**
 * Tenancy column — the ONE statement of which column a `tenant_scoped` entity
 * is scoped on, and whether codegen emits it or adopts one the entity already
 * declares (#791, ADR-042's 2026-11-11 revision).
 *
 * Inputs, in precedence order:
 *   1. the entity's `tenant_scoped: { column: <snake_name> }`;
 *   2. the project's `tenancy.column` in `codegen.config.yaml` (always present —
 *      the config schema defaults it to `tenant_id`, and every caller passes it).
 *
 * Then, for that column name:
 *   - a `belongs_to` whose `foreign_key:` is the column → ADOPTED; the belongs_to
 *     emits the column (with its FK and its own nullability);
 *   - else a field declared under `fields:` with that name → ADOPTED; the field
 *     loop emits it with its own type and nullability;
 *   - else → EMITTED by the tenant block as a nullable `uuid` (ADR-042).
 *
 * The column may not be `id`, nor any column a behavior the entity carries (its
 * `behaviors:` plus the ones its pattern implies — `Integrated` implies
 * `external_id_tracking`) already emits: the table would declare it twice. The
 * names come from `src/behaviors/` and `src/patterns/`, never a list kept here.
 *
 * Readers — every place that needs the tenant column of an entity: the entity
 * hygen prompt (`backend/entity-locals.js`, imported as
 * `src/schema/tenancy.js`), REL-1/REL-2's `entityScope` (the manifest's
 * per-entity scope constant, reached by the frontend graph too), the adapter
 * emitter's `buildSinkInput`, the semantic model's dimension roles
 * (`emitters/semantic/build-model.ts`) and the consistency checker's system-field
 * list. Each takes the project column as a required `string`. A reader that
 * re-derives it inline is a second rule.
 *
 * Imports only the shipped `src/` tree (listed in `package.json` `files`): the
 * hygen prompts import it from there.
 */

import { getBehavior, normalizeBehaviorConfig } from '../behaviors/index.js';
import type { BehaviorConfig } from '../behaviors/types.js';
import { camelCase } from '../config/file-naming.js';
import { resolveImpliedBehaviors } from '../patterns/implied-behaviors.js';

/** A tenant column name: snake_case. The config schema and the entity schema both validate against it. */
export const TENANT_COLUMN_PATTERN = /^[a-z][a-z0-9_]*$/;

/** The column `tenant_scoped` uses when neither the entity nor the project names one. */
export const DEFAULT_TENANT_COLUMN = 'tenant_id';

/** The YAML shape of `tenant_scoped:` — the boolean, or the object form naming a column. */
export type TenantScopedDeclaration = boolean | { column?: string } | null | undefined;

/** The parts of an entity declaration this module reads. Raw YAML or the parsed model. */
export interface TenancyEntityInput {
	/** The `entity:` block — read for the pattern(s) whose implied behaviors add columns. */
	entity?: { pattern?: string | null; patterns?: string[] | null } | null;
	/** The `behaviors:` list, as declared (a name or `{ name, options }`). */
	behaviors?: BehaviorConfig[] | null;
	tenant_scoped?: TenantScopedDeclaration;
	fields?: Record<string, { type?: string } | null | undefined> | null;
	relationships?: Record<
		string,
		{ type?: string; foreign_key?: string } | null | undefined
	> | null;
}

export interface ResolvedTenancy {
	/** The database column, snake_case (`organization_id`). */
	column: string;
	/** The Drizzle column property, camelCase (`organizationId`). */
	prop: string;
	/**
	 * Where the column comes from: `null` when the tenant block emits it, else
	 * the declaration that already does (`field`, or the `belongs_to` named).
	 */
	adopted: null | { kind: 'field' } | { kind: 'belongs_to'; relationship: string };
}

/** Whether `tenant_scoped:` turns scoping on (`true` or the object form). */
export function isTenantScoped(declaration: TenantScopedDeclaration): boolean {
	return declaration === true || (typeof declaration === 'object' && declaration !== null);
}

/**
 * The tenant column NAME for a declaration — the entity's own `column`, else the
 * project's; `null` when the entity is not `tenant_scoped`.
 * For readers that need the name but not the adoption rule (those holding a
 * parsed entity rather than the raw definition).
 */
export function tenantColumnName(
	declaration: TenantScopedDeclaration,
	projectColumn: string,
): string | null {
	if (!isTenantScoped(declaration)) return null;
	const entityColumn =
		typeof declaration === 'object' && declaration !== null ? declaration.column : undefined;
	return entityColumn ?? projectColumn;
}

/**
 * What already owns `column` on this entity's table — `id`, or a column a
 * behavior contributes — or `null` when nothing does. Names come from the
 * behavior definitions, so a new behavior column is covered without an edit here.
 */
function reservedColumnOwner(def: TenancyEntityInput, column: string): string | null {
	if (column === 'id') return "the primary key 'id'";
	const explicit = (def.behaviors ?? []).map((b) => normalizeBehaviorConfig(b).name);
	const implied = resolveImpliedBehaviors(def.entity ?? {}).filter((b) => !explicit.includes(b));
	for (const name of [...explicit, ...implied]) {
		const behavior = getBehavior(name);
		if (behavior?.fields.some((f) => f.name === column)) {
			const via = implied.includes(name)
				? ` (implied by pattern: ${def.entity?.pattern ?? def.entity?.patterns?.join(', ')})`
				: '';
			return `the '${column}' column of the '${name}' behavior${via}`;
		}
	}
	return null;
}

/**
 * The resolved tenant column of one entity, or `null` when it is not
 * `tenant_scoped`.
 *
 * Throws, naming the entity, when an adopted field is not a `uuid`: the ambient
 * tenant is a uuid string (ADR-042), and a configurable tenant `type:` is a
 * separate decision (#791 open question, out of scope).
 */
export function resolveTenancy(
	entityName: string,
	def: TenancyEntityInput,
	projectColumn: string,
): ResolvedTenancy | null {
	const declaration = def.tenant_scoped;
	if (!isTenantScoped(declaration)) return null;

	const column = tenantColumnName(declaration, projectColumn);
	if (column === null) return null;
	const prop = camelCase(column);

	const collision = reservedColumnOwner(def, column);
	if (collision !== null) {
		throw new Error(
			`[codegen] '${entityName}': the tenant column '${column}' collides with ${collision}, ` +
				`which the table already declares. Name another column with ` +
				`tenant_scoped: { column: … } or tenancy.column.`,
		);
	}

	for (const [name, rel] of Object.entries(def.relationships ?? {})) {
		if (rel && rel.type === 'belongs_to' && rel.foreign_key === column) {
			return { column, prop, adopted: { kind: 'belongs_to', relationship: name } };
		}
	}

	const field = def.fields?.[column];
	if (field) {
		const type = field.type ?? 'string';
		if (type !== 'uuid') {
			throw new Error(
				`[codegen] '${entityName}': tenant_scoped adopts the field '${column}', but it is ` +
					`type: ${type}. The tenant column must be a uuid (ADR-042) — declare it ` +
					`'type: uuid', or name another column with tenant_scoped: { column: … }.`,
			);
		}
		return { column, prop, adopted: { kind: 'field' } };
	}

	return { column, prop, adopted: null };
}
