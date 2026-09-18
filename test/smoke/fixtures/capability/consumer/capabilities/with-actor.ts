/**
 * `Actor` capability mixin — CAP-2 smoke fixture STAND-IN (consumer-authored).
 *
 * CAP-3 ships the real `Actor` capability. Until then CAP-2's validator only
 * needs an entity to *declare* a `kind: 'capability'` pattern named `Actor`, so
 * this project declares its own — the app-capability path ADR-041 already
 * supports. It contributes a mixin (a capability must contribute something)
 * and no methods: there is nothing for it to do before CAP-3 defines it.
 */
import type { RepositoryCtor } from '__RUNTIME_BASE_CLASSES__/capability-mixin';

export function WithActor<TBase extends RepositoryCtor>(Base: TBase) {
	abstract class ActorMixin extends Base {}
	return ActorMixin as TBase & typeof ActorMixin;
}
