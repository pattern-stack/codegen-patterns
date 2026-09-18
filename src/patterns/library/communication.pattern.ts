/**
 * CommunicationPattern — an interaction with actors in roles (ADR-041.1, CAP-3).
 *
 * A capability layering `WithCommunication` onto the entity's spine
 * (typically `patterns: [Activity, Communication]`). It has no `config:`
 * block: its configuration IS the entity's `roles:` block (CAP-2), which
 * codegen resolves to FK columns and junction tables and emits as
 * `communicationConfig` on the repository. `roles:` and `Communication`
 * imply each other (`validateRolesCommunicationPairing`).
 *
 * Contributes `findByRole(role, actorId)` and `participants(id)` to the
 * repository and forwards both on the service.
 *
 * See `runtime/base-classes/with-communication.ts` and `docs/specs/CAP-3.md`.
 */

import { defineCapabilityPattern } from '../pattern-definition.js';
import { COMMUNICATION_CAPABILITY } from '../../roles/derive.js';

export const CommunicationPattern = defineCapabilityPattern({
	name: COMMUNICATION_CAPABILITY,
	kind: 'capability',
	mixin: 'WithCommunication',
	mixinImport: '@shared/base-classes/with-communication',
	forwarderMethods: ['findByRole', 'participants'],
	description:
		'An interaction with actors in roles — findByRole / participants, driven by the roles: block',
});
