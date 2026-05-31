/**
 * Tests for the provider definition schema (RFC-0001 §1, D1).
 *
 * Covers the *intra-file* contract only:
 *   - the happy-path shapes (multi-surface + single-surface),
 *   - `auth.scopes` required iff `auth.type: oauth2`,
 *   - the `import-path#Export` reference format,
 *   - `surfaces` non-empty,
 *   - `slug` kebab-case, `client.base_url` absolute URL,
 *   - `.strict()` rejection of unknown keys.
 *
 * Cross-file rules (slug uniqueness, surface subset, pre-flight import
 * resolution) live in validate-providers.test.ts.
 */

import { describe, it, expect } from 'bun:test';
import {
	ProviderDefinitionSchema,
	parseImportRef,
	IMPORT_REF_RE,
} from '../../schema/provider-definition.schema';

const googleValid = {
	slug: 'google',
	display_name: 'Google',
	auth: {
		type: 'oauth2',
		strategy:
			'@app/integrations/providers/google/google-oauth.strategy#GoogleOAuthStrategy',
		scopes: [
			'https://www.googleapis.com/auth/calendar.readonly',
			'https://www.googleapis.com/auth/gmail.readonly',
		],
	},
	client: {
		class: '@app/integrations/providers/google/google.client#GoogleClient',
		base_url: 'https://www.googleapis.com',
	},
	surfaces: ['calendar', 'mail', 'transcript'],
	token_lifetime: 3600,
	refresh_behavior: 'rotating',
};

const hubspotValid = {
	slug: 'hubspot',
	display_name: 'HubSpot',
	auth: {
		type: 'oauth2',
		strategy:
			'@app/integrations/providers/hubspot/hubspot-oauth.strategy#HubspotOAuthStrategy',
		scopes: ['crm.objects.contacts.read'],
	},
	client: {
		class: '@app/integrations/providers/hubspot/hubspot.client#HubspotClient',
		base_url: 'https://api.hubapi.com',
	},
	surfaces: ['crm'],
};

describe('ProviderDefinitionSchema — valid shapes', () => {
	it('accepts a multi-surface oauth2 provider', () => {
		const result = ProviderDefinitionSchema.safeParse(googleValid);
		expect(result.success).toBe(true);
	});

	it('accepts a single-surface provider without optional fields', () => {
		const result = ProviderDefinitionSchema.safeParse(hubspotValid);
		expect(result.success).toBe(true);
	});

	it('accepts a non-oauth2 provider without scopes', () => {
		const apiKey = {
			...hubspotValid,
			auth: { type: 'api-key', strategy: hubspotValid.auth.strategy },
		};
		const result = ProviderDefinitionSchema.safeParse(apiKey);
		expect(result.success).toBe(true);
	});
});

describe('ProviderDefinitionSchema — auth.scopes iff oauth2', () => {
	it('rejects oauth2 with no scopes', () => {
		const { scopes, ...authNoScopes } = googleValid.auth;
		const bad = { ...googleValid, auth: authNoScopes };
		const result = ProviderDefinitionSchema.safeParse(bad);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].path).toContain('scopes');
		}
	});

	it('rejects oauth2 with an empty scopes array', () => {
		const bad = { ...googleValid, auth: { ...googleValid.auth, scopes: [] } };
		const result = ProviderDefinitionSchema.safeParse(bad);
		expect(result.success).toBe(false);
	});
});

describe('ProviderDefinitionSchema — import-ref format', () => {
	it('rejects an auth.strategy without a #Export suffix', () => {
		const bad = {
			...googleValid,
			auth: { ...googleValid.auth, strategy: '@app/foo/bar.strategy' },
		};
		const result = ProviderDefinitionSchema.safeParse(bad);
		expect(result.success).toBe(false);
	});

	it('rejects a client.class with two # separators', () => {
		const bad = {
			...googleValid,
			client: { ...googleValid.client, class: '@app/a#B#C' },
		};
		const result = ProviderDefinitionSchema.safeParse(bad);
		expect(result.success).toBe(false);
	});

	it('IMPORT_REF_RE matches a well-formed ref and rejects malformed ones', () => {
		expect(IMPORT_REF_RE.test('@app/x/y.strategy#Foo')).toBe(true);
		expect(IMPORT_REF_RE.test('./rel/path#Bar')).toBe(true);
		expect(IMPORT_REF_RE.test('no-hash')).toBe(false);
		expect(IMPORT_REF_RE.test('path#')).toBe(false);
		expect(IMPORT_REF_RE.test('path#1Bad')).toBe(false);
		expect(IMPORT_REF_RE.test('#Foo')).toBe(false);
	});

	it('parseImportRef splits path and export', () => {
		expect(parseImportRef('@app/x/y.strategy#Foo')).toEqual({
			path: '@app/x/y.strategy',
			exportName: 'Foo',
		});
	});
});

describe('ProviderDefinitionSchema — field rules', () => {
	it('rejects an empty surfaces array', () => {
		const bad = { ...googleValid, surfaces: [] };
		const result = ProviderDefinitionSchema.safeParse(bad);
		expect(result.success).toBe(false);
	});

	it('rejects a non-kebab slug', () => {
		const bad = { ...googleValid, slug: 'Google_Provider' };
		const result = ProviderDefinitionSchema.safeParse(bad);
		expect(result.success).toBe(false);
	});

	it('rejects a non-URL base_url', () => {
		const bad = {
			...googleValid,
			client: { ...googleValid.client, base_url: 'not-a-url' },
		};
		const result = ProviderDefinitionSchema.safeParse(bad);
		expect(result.success).toBe(false);
	});

	it('rejects unknown top-level keys (strict)', () => {
		const bad = { ...googleValid, kind: 'crm' };
		const result = ProviderDefinitionSchema.safeParse(bad);
		expect(result.success).toBe(false);
	});

	it('rejects an unknown auth.type', () => {
		const bad = {
			...googleValid,
			auth: { ...googleValid.auth, type: 'magic-link' },
		};
		const result = ProviderDefinitionSchema.safeParse(bad);
		expect(result.success).toBe(false);
	});
});
