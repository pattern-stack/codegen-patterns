/**
 * ActivityPattern — config-driven subject-scoped interaction base.
 *
 * Activity entities represent interactions (calls, meetings, emails, messages,
 * transcripts) that reference a *subject* — the thing the interaction is about.
 * Which subject is a per-entity fact, not a library constant: a CRM activity is
 * scoped to an `opportunity`, a swe-brain interaction to a `person` (later
 * `repo`/`team`, ADR-0006's Salesforce Activities-vs-Records shape). The base
 * repository/service therefore expose **generic** subject-scoped finders
 * (`findBySubjectId` / `findRecentBySubjectId`) that read the subject FK column
 * from the entity's `config:` block, on top of the standard CRUD methods plus
 * date-range and actor (`user_id`) scoping.
 *
 * The subject FK column resolves from `config: { Activity: { ... } }`:
 *   - `subjectColumn` — explicit snake_case column, OR
 *   - `<subject>_id` — derived from the `subject` entity name.
 * The recency-ordering column is `occurredAt` (snake_case in config), default
 * `occurred_at`. The base reads these via `this.patternConfig` — the same
 * ADR-031 §4 hand-off `IntegratedEntityRepository` uses for `integrationConfig`.
 *
 * See `docs/specs/ACTIVITY-SUBJECT-1.md`.
 */

import { z } from 'zod';
import { definePattern } from '../pattern-definition.js';

/**
 * Per-entity `config: { Activity: {...} }` block, validated at parse time.
 * All fields optional — a date/user-only Activity entity supplies no config
 * (and the subject finders throw if called). `.strict()` rejects misspelled
 * keys loudly, matching JunctionPattern.
 */
const ActivityPatternConfigSchema = z
	.object({
		/** Subject entity name → derives the FK column `<subject>_id`. */
		subject: z.string().optional(),
		/** Explicit snake_case FK column, when it does not follow `<subject>_id`. */
		subjectColumn: z.string().optional(),
		/** snake_case recency-ordering column; defaults to `occurred_at`. */
		occurredAt: z.string().optional(),
	})
	.strict();

export const ActivityPattern = definePattern({
	name: 'Activity',
	extends: ['Base'],
	repositoryClass: 'ActivityEntityRepository',
	serviceClass: 'ActivityEntityService',
	repositoryImport: '@shared/base-classes/activity-entity-repository',
	serviceImport: '@shared/base-classes/activity-entity-service',
	configSchema: ActivityPatternConfigSchema,
	repositoryInheritedMethods: [
		'findById, findByIds, list, count, exists, create, update, delete, upsertMany',
		'findByDateRange, findByUserId, findBySubjectId, findRecentBySubjectId',
	],
	serviceInheritedMethods: [
		'findById, findByIds, list, count, exists, create, update, delete',
		'findByDateRange, findByUser, findBySubject, findRecent',
	],
	description:
		'Subject-scoped interaction entities — date-range + actor + config-driven subject lookups',
});
