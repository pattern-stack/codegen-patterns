/**
 * Patterns public surface.
 *
 * Importing this barrel has the side effect of registering every
 * library-shipped pattern with the registry. The CLI and the Hygen
 * subprocess both import here to guarantee a populated registry before
 * any codegen work begins.
 */

// Side-effect: register library patterns.
import './library/index.js';

export {
	definePattern,
	defineOrchestrationPattern,
	isDomainPattern,
	isOrchestrationPattern,
	isPatternDefinition,
	type AnyPatternDefinition,
	type OrchestrationPatternDefinition,
	type OrchestrationRegistrySpec,
	type PatternColumnContribution,
	type PatternDefinition,
	type PatternKind,
} from './pattern-definition.js';

export {
	getAllOrchestrationPatterns,
	getAllPatternNames,
	getAppPatternNames,
	getLibraryPatternNames,
	getOrchestrationPattern,
	getOrchestrationPatternNames,
	getPattern,
	loadAppPatterns,
	registerLibraryPattern,
	type LoadAppPatternsResult,
} from './registry.js';

export {
	validatePatternComposition,
	validatePatternProject,
	type PatternProjectContext,
} from './validate-composition.js';

export {
	validateOrchestrationProject,
	type OrchestrationProjectContext,
} from './validate-orchestration.js';

// Library pattern values — available for consumers that want to reference
// them programmatically (rare, but cheap to export).
export {
	ActivityPattern,
	BasePattern,
	JunctionPattern,
	KnowledgePattern,
	MetadataPattern,
	IntegratedPattern,
} from './library/index.js';

// BaseJunctionFields — re-exported for downstream template / codegen leaves
// that need to reason about the shared junction shape.
export {
	BaseJunctionFields,
	BASE_JUNCTION_FIELD_NAMES,
} from './library/index.js';
