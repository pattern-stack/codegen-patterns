/**
 * ActivityPattern registry-surface tests (ACTIVITY-SUBJECT-1).
 *
 * Confirms the pattern is reachable through the library barrel, advertises the
 * config-driven subject finders (not the deleted CRM-named ones), and that its
 * configSchema validates `{ subject }` / `{}` and rejects unknown keys.
 */

import { describe, test, expect } from 'bun:test';

// Importing the barrel pre-registers the library patterns as a side effect.
import '../../patterns/index.ts';

import { getPattern, getLibraryPatternNames } from '../../patterns/registry.ts';
import { ActivityPattern } from '../../patterns/library/index.ts';

describe('ActivityPattern', () => {
	test('is registered under the name "Activity"', () => {
		const def = getPattern('Activity');
		expect(def).toBeDefined();
		expect(def?.name).toBe('Activity');
	});

	test('appears in getLibraryPatternNames()', () => {
		expect(getLibraryPatternNames()).toContain('Activity');
	});

	test('declares the ActivityEntity base classes', () => {
		expect(ActivityPattern.repositoryClass).toBe('ActivityEntityRepository');
		expect(ActivityPattern.serviceClass).toBe('ActivityEntityService');
	});

	test('advertises the config-driven subject finders', () => {
		const repoMethods = (ActivityPattern.repositoryInheritedMethods ?? []).join(
			', ',
		);
		expect(repoMethods).toContain('findBySubjectId');
		expect(repoMethods).toContain('findRecentBySubjectId');
		// Actor scoping stays; it is not CRM-shaped.
		expect(repoMethods).toContain('findByUserId');
		expect(repoMethods).toContain('findByDateRange');
	});

	test('no longer advertises the CRM-named opportunity finders (clean cut)', () => {
		const repoMethods = (ActivityPattern.repositoryInheritedMethods ?? []).join(
			', ',
		);
		const serviceMethods = (ActivityPattern.serviceInheritedMethods ?? []).join(
			', ',
		);
		expect(repoMethods).not.toContain('Opportunity');
		expect(serviceMethods).not.toContain('Opportunity');
	});

	test('exposes a configSchema', () => {
		expect(ActivityPattern.configSchema).toBeDefined();
	});
});

describe('ActivityPattern.configSchema', () => {
	const schema = ActivityPattern.configSchema!;

	test('accepts { subject }', () => {
		expect(schema.safeParse({ subject: 'person' }).success).toBe(true);
	});

	test('accepts { subjectColumn, occurredAt }', () => {
		expect(
			schema.safeParse({ subjectColumn: 'person_id', occurredAt: 'sent_at' })
				.success,
		).toBe(true);
	});

	test('accepts an empty config (date/user-only activity)', () => {
		expect(schema.safeParse({}).success).toBe(true);
	});

	test('rejects a non-string subject', () => {
		expect(schema.safeParse({ subject: 42 }).success).toBe(false);
	});

	test('rejects an unknown key (.strict)', () => {
		expect(schema.safeParse({ subjet: 'person' }).success).toBe(false);
	});
});
