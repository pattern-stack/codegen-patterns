/**
 * ActorPattern — an entity a role may point at (ADR-041.1, CAP-3).
 *
 * A capability, not a spine: it layers `WithActor` onto whatever base the
 * entity already has (`patterns: [Actor]` over `Base`, or
 * `[Integrated, Actor]`). CAP-2's roles validator requires a role's `target`
 * to declare it.
 *
 *   config:
 *     Actor: { kind: individual }                    # one actor
 *     Actor: { kind: group, members: contacts }      # members via a has_many
 *
 * `members:` names one of the entity's own `has_many` relationships; codegen
 * resolves it to the member table + FK and emits the result as `actorConfig`
 * on the repository (the author never writes a table or column). The mixin's
 * `memberPredicate(actorId)` is repository vocabulary (a Drizzle `SQL`
 * fragment), so nothing is forwarded to the service.
 *
 * See `runtime/base-classes/with-actor.ts` and `docs/specs/CAP-3.md`.
 */

import { z } from 'zod';
import { defineCapabilityPattern } from '../pattern-definition.js';
import { ACTOR_CAPABILITY } from '../../roles/derive.js';

/**
 * `individual` takes nothing else; `group` must name its members. `.strict()`
 * on both arms, so `members:` on an individual is an error, not a no-op.
 */
export const ActorPatternConfigSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('individual') }).strict(),
	z
		.object({
			kind: z.literal('group'),
			/** Name of one of this entity's `has_many` relationships. */
			members: z.string().min(1),
		})
		.strict(),
]);

export type ActorPatternConfig = z.infer<typeof ActorPatternConfigSchema>;

export const ActorPattern = defineCapabilityPattern<ActorPatternConfig>({
	name: ACTOR_CAPABILITY,
	kind: 'capability',
	mixin: 'WithActor',
	mixinImport: '@shared/base-classes/with-actor',
	configSchema: ActorPatternConfigSchema,
	description:
		'An entity a role may point at — an individual, or a group with members via a has_many',
});
