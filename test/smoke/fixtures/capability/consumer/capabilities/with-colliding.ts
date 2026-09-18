/**
 * `Colliding` capability mixin — CAP-1 NEGATIVE smoke fixture.
 *
 * Contributes `findByEmail`, which is also what a `queries: [{ by: [email] }]`
 * entry generates. Generation must refuse this pair (ADR-041 §4) instead of
 * emitting two declarations of one method.
 */
import type { EntityOf, RepositoryCtor } from '__RUNTIME_BASE_CLASSES__/capability-mixin';

export function WithColliding<TBase extends RepositoryCtor>(Base: TBase) {
	abstract class CollidingMixin extends Base {
		async findByEmail(email: string): Promise<EntityOf<TBase> | null> {
			void email;
			return null;
		}
	}
	return CollidingMixin as TBase & typeof CollidingMixin;
}
