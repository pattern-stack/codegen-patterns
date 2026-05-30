/**
 * JunctionPattern — top-level discriminator for explicit many-to-many
 * junction YAML files.
 *
 * Unlike `Activity` / `Integrated` / `Metadata` (which attach to an entity via
 * `pattern:` / `patterns:`), `Junction` IS the top-level YAML shape — a
 * junction file's discriminator is `pattern: Junction`, not `entity:`.
 * It therefore does not declare `repositoryClass` / `serviceClass`: the
 * downstream Hygen-template leaf emits a dedicated junction repo/service
 * per pairing.
 *
 * `columns` is set to `BaseJunctionFields` for two reasons:
 *   1. Registry-side declaration of the shared shape — discoverable through
 *      `getPattern('Junction').columns` by the downstream template leaf.
 *   2. Satisfies the registry's `assertHasContribution()` check, which
 *      insists every pattern contribute at least one of columns / repo /
 *      service class. (See spec §"Open Questions Q3"; recommendation (a).)
 *
 * See `.ai-docs/stacks/codegen-app-patterns/specs/58.md`.
 */

import { z } from 'zod';
import { definePattern } from '../pattern-definition.js';
import { BaseJunctionFields } from './base-junction-fields.js';

/**
 * The `pattern: Junction`-attached config block, validated at parse time.
 *
 * Surface is intentionally thin in this leaf — extensions land in later
 * leaves (templates, association-codegen). `.strict()` rejects unknown
 * keys so consumers who misspell a flag fail loudly.
 */
const JunctionPatternConfigSchema = z.object({}).strict();

export const JunctionPattern = definePattern({
	name: 'Junction',
	description:
		'Explicit many-to-many junction with role + temporal + sourcing metadata',
	columns: [...BaseJunctionFields],
	configSchema: JunctionPatternConfigSchema,
});
