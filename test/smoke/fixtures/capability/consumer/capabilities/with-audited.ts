/**
 * `Audited` capability mixin — CAP-1 smoke fixture (consumer-authored).
 *
 * The third layer. Deliberately trivial: its job in this fixture is depth —
 * ADR-041's "Testing / safety" asks for three capabilities stacked over the
 * real published bases.
 */
import type { RepositoryCtor } from '__RUNTIME_BASE_CLASSES__/capability-mixin';

export function WithAudited<TBase extends RepositoryCtor>(Base: TBase) {
	abstract class AuditedMixin extends Base {
		async auditCount(): Promise<number> {
			return this.count();
		}
	}
	return AuditedMixin as TBase & typeof AuditedMixin;
}
