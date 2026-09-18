/**
 * `Individual` capability mixin — CAP-1 smoke fixture (consumer-authored).
 *
 * Contributes a method whose return type is the *concrete* entity, which is
 * what proves generic signatures survive composition (CAP-1 §M7): on the
 * account fixture `principal()` returns `Account | null`, not `unknown`.
 */
import type { EntityOf, RepositoryCtor } from '__RUNTIME_BASE_CLASSES__/capability-mixin';

export function WithIndividual<TBase extends RepositoryCtor>(Base: TBase) {
	abstract class IndividualMixin extends Base {
		async principal(id: string): Promise<EntityOf<TBase> | null> {
			return this.findById(id) as Promise<EntityOf<TBase> | null>;
		}
	}
	return IndividualMixin as TBase & typeof IndividualMixin;
}
