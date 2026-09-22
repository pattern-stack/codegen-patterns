/**
 * `Group` capability mixin — CAP-1 smoke fixture (consumer-authored).
 *
 * Written exactly the way ADR-041 expects an app capability to be written:
 * against the shipped contract in `capability-mixin`, layering on the
 * repository, reading its per-entity config from an inherited property the
 * generated repository fills, and going through the repository's own scoped
 * `baseQuery()` rather than taking a scope parameter (charter I3).
 *
 * `__RUNTIME_BASE_CLASSES__` is substituted by the harness — `@shared/…` for
 * the vendored leg, `@pattern-stack/codegen/runtime/…` for the package leg.
 */
import { eq } from 'drizzle-orm';
import type { EntityOf, RepositoryCtor } from '__RUNTIME_BASE_CLASSES__/capability-mixin';

export interface GroupConfig {
	/** camelCase column the membership predicate filters on. */
	readonly membersColumn: string;
}

export function WithGroup<TBase extends RepositoryCtor>(Base: TBase) {
	abstract class GroupMixin extends Base {
		/** Filled by the generated repository from `config: { Group: {...} }`. */
		protected readonly groupConfig?: GroupConfig;

		async members(value: string): Promise<Array<EntityOf<TBase>>> {
			const column = this.groupConfig?.membersColumn ?? 'id';
			const rows = await this.baseQuery(eq(this.col(column), value));
			return rows as Array<EntityOf<TBase>>;
		}
	}
	return GroupMixin as TBase & typeof GroupMixin;
}
