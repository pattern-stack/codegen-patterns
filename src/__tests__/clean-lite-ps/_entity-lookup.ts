/**
 * Base locals for unit tests that build clean-lite-ps locals by hand: the
 * locals `templates/entity/new/prompt.js` owns (#638), plus the cross-entity
 * lookup (NAME-0).
 *
 * The clean-lite-ps templates reference every local unguarded, so a test that
 * leaves one out gets a ReferenceError, never a silent fallback. The runtime
 * import specifiers come from `runtimeImportLocals`, the table `prompt.js`
 * uses, for `base.runtimeMode` (default `vendored`, whose `@shared/*`
 * specifiers the template tests assert).
 *
 * The cross-entity lookup (NAME-0): `prompt.js` passes one read from the entities directory; a
 * test has no directory, so it names the targets its definitions reference.
 * Each carries the `plural:` its YAML would declare — resolution reads it from
 * here, never by pluralizing the name.
 */
import { entityLookupFrom } from '../../../templates/_shared/entity-naming.mjs';
import { runtimeImportLocals } from '../../../src/config/runtime-mode.mjs';

const TARGETS = [
	{ name: 'account', plural: 'accounts' },
	{ name: 'contact', plural: 'contacts' },
	{ name: 'conversation', plural: 'conversations' },
	{ name: 'field_definition', plural: 'field_definitions' },
	{ name: 'field_value', plural: 'field_values' },
	{ name: 'lead', plural: 'leads' },
	{ name: 'post', plural: 'posts' },
	{ name: 'user', plural: 'users' },
];

/** The prompt-owned locals, then `base`, then the test entity lookup. */
export function withEntities<T extends Record<string, unknown>>(
	base: T = {} as T,
): T & { entityLookup: ReturnType<typeof entityLookupFrom> } {
	const runtimeMode = base.runtimeMode === 'package' ? 'package' : 'vendored';
	return {
		generatedBanner: '',
		runtimeMode,
		...runtimeImportLocals(runtimeMode),
		processedQueries: [],
		hasEmits: false,
		emitsEvents: [],
		createEventType: null,
		updateEventType: null,
		deleteEventType: null,
		...base,
		entityLookup: entityLookupFrom(TARGETS),
	};
}
