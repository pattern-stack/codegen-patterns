/**
 * Fixture: orchestration pattern named `Synced` — collides with the
 * library-shipped domain pattern of the same name.
 */

import { defineOrchestrationPattern } from '../../../../patterns/pattern-definition.ts';

export const SyncedOrchestrationPattern = defineOrchestrationPattern({
	name: 'Synced',
	kind: 'orchestration',
	registry: {
		keyType: 'SomeKey',
		valueType: 'SomeValue',
		entries: [{ key: 'a', provider: 'AProvider' }],
	},
});
