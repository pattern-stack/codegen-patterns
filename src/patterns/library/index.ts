/**
 * Library pattern bootstrap — imports every shipped pattern and registers
 * it with the shared library registry. Side-effect-only module: importing
 * this barrel is what pre-registers `Base`, `Integrated`, `Activity`,
 * `Knowledge`, `Metadata`, `Junction`, and the two capabilities `Actor` and
 * `Communication` (ADR-041.1).
 *
 * Adding a new library pattern is two edits: create the `*.pattern.ts`
 * file and add it to `LIBRARY_PATTERN_DEFINITIONS` below.
 */

import { registerLibraryPattern } from '../registry.js';
import { ActivityPattern } from './activity.pattern.js';
import { ActorPattern } from './actor.pattern.js';
import { BasePattern } from './base.pattern.js';
import { CommunicationPattern } from './communication.pattern.js';
import { JunctionPattern } from './junction.pattern.js';
import { KnowledgePattern } from './knowledge.pattern.js';
import { MetadataPattern } from './metadata.pattern.js';
import { IntegratedPattern } from './integrated.pattern.js';

/**
 * Every library-shipped entity pattern, in registration order. The one list —
 * tests that reset the registry re-seed from it rather than restating it.
 */
export const LIBRARY_PATTERN_DEFINITIONS = [
	BasePattern,
	IntegratedPattern,
	ActivityPattern,
	KnowledgePattern,
	MetadataPattern,
	JunctionPattern,
	ActorPattern,
	CommunicationPattern,
] as const;

for (const def of LIBRARY_PATTERN_DEFINITIONS) registerLibraryPattern(def);

export {
	ActivityPattern,
	ActorPattern,
	BasePattern,
	CommunicationPattern,
	JunctionPattern,
	KnowledgePattern,
	MetadataPattern,
	IntegratedPattern,
};
export {
	BaseJunctionFields,
	BASE_JUNCTION_FIELD_NAMES,
} from './base-junction-fields.js';
