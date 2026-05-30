/**
 * Library pattern bootstrap — imports every shipped pattern and registers
 * it with the shared library registry. Side-effect-only module: importing
 * this barrel is what pre-registers `Base`, `Integrated`, `Activity`,
 * `Knowledge`, and `Metadata`.
 *
 * Adding a new library pattern is two edits: create the `*.pattern.ts`
 * file and add the import+register pair below.
 */

import { registerLibraryPattern } from '../registry.js';
import { ActivityPattern } from './activity.pattern.js';
import { BasePattern } from './base.pattern.js';
import { JunctionPattern } from './junction.pattern.js';
import { KnowledgePattern } from './knowledge.pattern.js';
import { MetadataPattern } from './metadata.pattern.js';
import { IntegratedPattern } from './integrated.pattern.js';

registerLibraryPattern(BasePattern);
registerLibraryPattern(IntegratedPattern);
registerLibraryPattern(ActivityPattern);
registerLibraryPattern(KnowledgePattern);
registerLibraryPattern(MetadataPattern);
registerLibraryPattern(JunctionPattern);

export {
	ActivityPattern,
	BasePattern,
	JunctionPattern,
	KnowledgePattern,
	MetadataPattern,
	IntegratedPattern,
};
export {
	BaseJunctionFields,
	BASE_JUNCTION_FIELD_NAMES,
} from './base-junction-fields.js';
