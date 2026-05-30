/**
 * Fixture: orchestration pattern named `Integrated` — collides with the
 * library-shipped domain pattern of the same name.
 */

import { defineOrchestrationPattern } from '../../../../patterns/pattern-definition.ts';

export const IntegratedOrchestrationPattern = defineOrchestrationPattern({
	name: 'Integrated',
	kind: 'orchestration',
	registry: {
		keyType: 'SomeKey',
		valueType: 'SomeValue',
		entries: [{ key: 'a', provider: 'AProvider' }],
	},
});
