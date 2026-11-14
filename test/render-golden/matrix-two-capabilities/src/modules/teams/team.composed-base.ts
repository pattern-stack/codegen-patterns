
import { ActivityEntityRepository } from '@shared/base-classes/activity-entity-repository';
import { WithActor } from '@shared/base-classes/with-actor';
import { WithCommunication } from '@shared/base-classes/with-communication';
import { teams, type Team } from './team.entity';
import type { Relations } from '../../generated/relations';

/**
 * Composed repository base for Team — the `Activity` spine with
 * 2 capabilities layered over it (ADR-041).
 *
 * Nesting follows declaration order in the entity's `patterns:` list, rightmost
 * outermost:
 *   - Actor (WithActor)
 *   - Communication (WithCommunication)
 *
 * Abstract members of the spine stay abstract here and are implemented by the
 * concrete TeamRepository.
 */
export abstract class TeamComposedBase extends WithCommunication(WithActor(ActivityEntityRepository<Team, typeof teams, Relations>)) {}
