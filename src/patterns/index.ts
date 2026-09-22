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
	defineCapabilityPattern,
	definePattern,
	defineOrchestrationPattern,
	isCapabilityPattern,
	isDomainPattern,
	isOrchestrationPattern,
	isPatternDefinition,
	type AnyPatternDefinition,
	type CapabilityPatternDefinition,
	type EntityPatternDefinition,
	type OrchestrationPatternDefinition,
	type OrchestrationRegistrySpec,
	type PatternColumnContribution,
	type PatternDefinition,
	type PatternKind,
} from './pattern-definition.js';

// Composition (ADR-041) — spine selection + capability layering.
export {
	composePatterns,
	declaredPatternNames,
	detectMethodCollisions,
	DEFAULT_SPINE,
	type ComposedPatterns,
	type CompositionError,
	type CompositionErrorCode,
	type MethodVocabulary,
	type PatternDeclaringEntity,
} from './compose.js';

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
	type AppPatternLoadError,
	type LoadAppPatternsResult,
} from './registry.js';

export { validatePatternComposition } from './validate-composition.js';

export {
	validateOrchestrationProject,
	type OrchestrationProjectContext,
} from './validate-orchestration.js';

// Library pattern values — available for consumers that want to reference
// them programmatically (rare, but cheap to export).
export {
	ActivityPattern,
	ActorPattern,
	BasePattern,
	CommunicationPattern,
	JunctionPattern,
	KnowledgePattern,
	LIBRARY_PATTERN_DEFINITIONS,
	MetadataPattern,
	IntegratedPattern,
} from './library/index.js';
export {
	ActorPatternConfigSchema,
	type ActorPatternConfig,
} from './library/actor.pattern.js';

// BaseJunctionFields — re-exported for downstream template / codegen leaves
// that need to reason about the shared junction shape.
export {
	BaseJunctionFields,
	BASE_JUNCTION_FIELD_NAMES,
} from './library/index.js';
