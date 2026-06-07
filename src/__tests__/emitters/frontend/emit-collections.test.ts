/**
 * Frontend emitter — collection emission tests (ADR-038, FE-2).
 *
 * String-level (pure builders, no fs). Includes the 3 cases ported from the
 * deleted clean-lite-ps/frontend-sync-mode.test.ts (electric default, api mode,
 * API_BASE_URL variant), plus per-entity override, auth on/off, parser/column-
 * mapper emission, the SSR guard, the index barrel, and determinism.
 */

import { describe, expect, it } from 'bun:test';
import {
	buildCollectionFile,
	buildCollectionsIndexFile,
} from '../../../emitters/frontend/emit-collections';
import { config, ctx, entry } from './_helpers';

describe('emit-collections — electric (default) branch', () => {
	it('emits electricCollectionOptions + shapeOptions, no queryCollectionOptions', () => {
		const c = ctx([entry('contact', 'contacts')]);
		const out = buildCollectionFile(entry('contact', 'contacts'), c);
		expect(out).toContain('electricCollectionOptions({');
		expect(out).toContain('shapeOptions:');
		expect(out).not.toContain('queryCollectionOptions');
		expect(out).toContain('schema: contactSchema');
		expect(out).toContain('getKey: (item) => item.id');
	});

	it('imports the Zod schema directly by name from dbEntities (no schemaPrefix)', () => {
		const c = ctx([entry('contact', 'contacts')], {
			dbEntitiesImport: '@repo/db/entities',
		});
		const out = buildCollectionFile(entry('contact', 'contacts'), c);
		expect(out).toContain("import { contactSchema } from '@repo/db/entities/contact';");
		expect(out).not.toContain('schema.contactSchema');
	});

	it('guards window access with the SSR check uniformly', () => {
		const c = ctx([entry('contact', 'contacts')]);
		const out = buildCollectionFile(entry('contact', 'contacts'), c);
		expect(out).toContain("typeof window !== 'undefined' ? window.location.origin : ''");
	});

	it('emits the parser block from frontend.parsers', () => {
		const c = ctx([entry('contact', 'contacts')], {
			parsers: { timestamptz: '(date: string) => new Date(date)' },
		});
		const out = buildCollectionFile(entry('contact', 'contacts'), c);
		expect(out).toContain('parser: {');
		expect(out).toContain('timestamptz: (date: string) => new Date(date),');
	});

	it('emits the table-param shape URL form when useTableParam', () => {
		const c = ctx([entry('contact', 'contacts')], { useTableParam: true });
		const out = buildCollectionFile(entry('contact', 'contacts'), c);
		expect(out).toContain('params: {');
		expect(out).toContain("table: 'contacts',");
	});

	it('emits columnMapper with a call when columnMapperNeedsCall', () => {
		const c = ctx([entry('contact', 'contacts')], {
			columnMapper: 'snakeCamelMapper',
			columnMapperNeedsCall: true,
		});
		const out = buildCollectionFile(entry('contact', 'contacts'), c);
		expect(out).toContain('columnMapper: snakeCamelMapper(),');
		expect(out).toContain("import { snakeCamelMapper } from '@electric-sql/client';");
	});

	it('emits columnMapper as a reference when columnMapperNeedsCall is false', () => {
		const c = ctx([entry('contact', 'contacts')], {
			columnMapper: 'snakeCamelMapper',
			columnMapperNeedsCall: false,
		});
		const out = buildCollectionFile(entry('contact', 'contacts'), c);
		expect(out).toContain('columnMapper: snakeCamelMapper,');
		expect(out).not.toContain('columnMapper: snakeCamelMapper(),');
	});

	it('emits an auth header when authFunction is set, none when null', () => {
		const withAuth = ctx([entry('contact', 'contacts')], {
			authFunction: 'getAuthorizationHeader',
		});
		const out = buildCollectionFile(entry('contact', 'contacts'), withAuth);
		expect(out).toContain('Authorization: getAuthorizationHeader(),');
		expect(out).toContain("import { getAuthorizationHeader } from '@/lib/collections/auth';");

		const noAuth = ctx([entry('contact', 'contacts')]);
		const out2 = buildCollectionFile(entry('contact', 'contacts'), noAuth);
		expect(out2).not.toContain('Authorization');
	});
});

describe('emit-collections — api branch', () => {
	it("'api' mode emits queryCollectionOptions + queryKey, no shapeOptions", () => {
		const c = ctx([entry('contact', 'contacts')], { globalSyncMode: 'api' });
		const out = buildCollectionFile(entry('contact', 'contacts'), c);
		expect(out).toContain('queryCollectionOptions({');
		expect(out).toContain("queryKey: ['contacts']");
		expect(out).toContain('queryClient,');
		expect(out).not.toContain('electricCollectionOptions');
		expect(out).not.toContain('shapeOptions');
	});

	it("'api' mode delegates transport to the api client (no inline fetch)", () => {
		const c = ctx([entry('contact', 'contacts')], { globalSyncMode: 'api' });
		const out = buildCollectionFile(entry('contact', 'contacts'), c);
		expect(out).toContain("import { contactApi } from '../api/contact';");
		expect(out).toContain("import { queryClient } from '../query-client';");
		// pagination-by-default: the list endpoint returns a Page<T>; the collection
		// queryFn unwraps `.items` to seed itself with the first page of rows. async/
		// await (not `.then`) so queryCollectionOptions keeps getKey's item typed.
		expect(out).toContain('queryFn: async () => {');
		expect(out).toContain('const page = await contactApi.list();');
		expect(out).toContain('return page.items;');
		expect(out).not.toContain('.then((p) => p.items)');
		expect(out).not.toContain('fetch(');
	});

	it('api collection imports the Zod schema directly from dbEntities', () => {
		const c = ctx([entry('contact', 'contacts')], { globalSyncMode: 'api' });
		const out = buildCollectionFile(entry('contact', 'contacts'), c);
		expect(out).toContain("import { contactSchema } from '@repo/db/entities/contact';");
		expect(out).toContain('schema: contactSchema,');
	});
});

describe('emit-collections — API_BASE_URL variant (ported)', () => {
	it('uses ${API_BASE_URL} in the electric shape URL when apiBaseUrlImport is set', () => {
		const c = ctx([entry('contact', 'contacts')], {
			apiBaseUrlImport: '@/config',
		});
		const out = buildCollectionFile(entry('contact', 'contacts'), c);
		expect(out).toContain("import { API_BASE_URL } from '@/config';");
		expect(out).toContain('`${API_BASE_URL}/contacts`');
	});
});

describe('emit-collections — per-entity override', () => {
	it('global electric + one entity sync:api → that entity is api, siblings electric', () => {
		const contact = entry('contact', 'contacts', 'api');
		const account = entry('account', 'accounts'); // inherits electric
		const c = ctx([contact, account], { globalSyncMode: 'electric' });

		const contactOut = buildCollectionFile(contact, c);
		expect(contactOut).toContain('queryCollectionOptions({');
		expect(contactOut).not.toContain('electricCollectionOptions');

		const accountOut = buildCollectionFile(account, c);
		expect(accountOut).toContain('electricCollectionOptions({');
		expect(accountOut).not.toContain('queryCollectionOptions');
	});

	it('global api + one entity sync:electric → that entity is electric, siblings api', () => {
		const contact = entry('contact', 'contacts', 'electric');
		const account = entry('account', 'accounts'); // inherits api
		const c = ctx([contact, account], { globalSyncMode: 'api' });

		expect(buildCollectionFile(contact, c)).toContain('electricCollectionOptions({');
		expect(buildCollectionFile(account, c)).toContain('queryCollectionOptions({');
	});
});

describe('emit-collections — index barrel', () => {
	it('re-exports each entity sorted by name', () => {
		const c = ctx([entry('zeta', 'zetas'), entry('alpha', 'alphas')]);
		const out = buildCollectionsIndexFile(c);
		const alphaIdx = out.indexOf("export * from './alpha';");
		const zetaIdx = out.indexOf("export * from './zeta';");
		expect(alphaIdx).toBeGreaterThan(-1);
		expect(zetaIdx).toBeGreaterThan(alphaIdx);
	});
});

describe('emit-collections — determinism + banner', () => {
	it('produces byte-identical output for the same context', () => {
		const make = () => ctx([entry('contact', 'contacts')], config());
		const a = buildCollectionFile(entry('contact', 'contacts'), make());
		const b = buildCollectionFile(entry('contact', 'contacts'), make());
		expect(a).toBe(b);
	});

	it('starts with the house @generated banner', () => {
		const c = ctx([entry('contact', 'contacts')]);
		const out = buildCollectionFile(entry('contact', 'contacts'), c);
		expect(out.startsWith('// @generated by @pattern-stack/codegen')).toBe(true);
	});
});
