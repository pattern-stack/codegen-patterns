/**
 * `Communication` capability mixin — CAP-2 smoke fixture STAND-IN
 * (consumer-authored).
 *
 * CAP-3 ships the real one (`findByRole`, `participants`), driven by the
 * entity's `roles:` block. CAP-2 only needs it to be declared: `roles:` and
 * `Communication` imply each other, and the validator checks for both.
 */
import type { RepositoryCtor } from '__RUNTIME_BASE_CLASSES__/capability-mixin';

export function WithCommunication<TBase extends RepositoryCtor>(Base: TBase) {
	abstract class CommunicationMixin extends Base {}
	return CommunicationMixin as TBase & typeof CommunicationMixin;
}
