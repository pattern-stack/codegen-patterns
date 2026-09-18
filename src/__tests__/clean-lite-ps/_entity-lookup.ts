/**
 * The cross-entity lookup for unit tests that build clean-lite-ps locals by
 * hand (NAME-0). `prompt.js` passes one read from the entities directory; a
 * test has no directory, so it names the targets its definitions reference.
 * Each carries the `plural:` its YAML would declare — resolution reads it from
 * here, never by pluralizing the name.
 */
import { entityLookupFrom } from '../../../templates/_shared/entity-naming.mjs';

const TARGETS = [
	{ name: 'account', plural: 'accounts' },
	{ name: 'contact', plural: 'contacts' },
	{ name: 'conversation', plural: 'conversations' },
	{ name: 'field_definition', plural: 'field_definitions' },
	{ name: 'lead', plural: 'leads' },
	{ name: 'post', plural: 'posts' },
	{ name: 'user', plural: 'users' },
];

/** `baseLocals` plus the test entity lookup. */
export function withEntities<T extends Record<string, unknown>>(
	base: T = {} as T,
): T & { entityLookup: ReturnType<typeof entityLookupFrom> } {
	return { ...base, entityLookup: entityLookupFrom(TARGETS) };
}
