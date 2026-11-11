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
 * Readers — every place that needs the tenant column of an entity: the entity
 * hygen prompt (`backend/entity-locals.js`, imported as
 * `src/schema/tenancy.js`), REL-1/REL-2's `entityScope` (the manifest's
 * per-entity scope constant, reached by the frontend graph too) and the adapter
 * emission's `buildSinkInput`. Each takes the project column as a required `string`. A reader that re-derives it inline is a second rule.
 *
 * Kept dependency-free: the hygen prompts import it straight from the shipped
 * `src/` tree (listed in `package.json` `files`).
 */

/** The YAML shape of `tenant_scoped:` — the boolean, or the object form naming a column. */
export type TenantScopedDeclaration = boolean | { column?: string } | null | undefined;

/** The parts of an entity declaration this module reads. Raw YAML or the parsed model. */
export interface TenancyEntityInput {
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

/** `organization_id` → `organizationId` — the templates' own camelCase rule. */
function camel(snake: string): string {
	return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Whether `tenant_scoped:` turns scoping on (`true` or the object form). */
export function isTenantScoped(declaration: TenantScopedDeclaration): boolean {
	return declaration === true || (typeof declaration === 'object' && declaration !== null);
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

	const entityColumn =
		typeof declaration === 'object' && declaration !== null ? declaration.column : undefined;
	const column = entityColumn ?? projectColumn;
	const prop = camel(column);

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
