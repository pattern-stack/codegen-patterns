/**
 * Frontend emitter — load-context tests (ADR-038, FE-4).
 *
 * Two surfaces:
 *  1. `mapFrontendEmitConfig` — the config → FrontendEmitConfig mapping, incl.
 *     defaults (absent block), the auth null-disables convention, per-knob
 *     overrides, architecture passthrough, and location resolution.
 *  2. `loadFrontendEmitContext` — registry + parsed loading, the zero-entities
 *     skip, and the outDir resolution from `locations.frontendGenerated`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	loadFrontendEmitContext,
	mapFrontendEmitConfig,
} from '../../../emitters/frontend/load-context';
import {
	buildStoreIndexFile,
	buildResolversFile,
	lookupFullFetchNames,
} from '../../../emitters/frontend/emit-store';

// A focused, intentional entity set (explicit-plural `person` + FK-consumer
// `user`) — the same fixtures the golden-tree emitter snapshot uses. Avoids the
// noisy shared `test/fixtures` tree (config YAMLs, junctions, providers) so the
// registry/parsed assertions stay deterministic.
const FIXTURES = resolve(
	import.meta.dir,
	'../../../../test/frontend-golden/entities',
);

describe('mapFrontendEmitConfig — defaults (absent frontend block)', () => {
	it('applies the schema defaults when no frontend block is present', () => {
		const c = mapFrontendEmitConfig({});
		expect(c.globalSyncMode).toBe('electric');
		expect(c.authFunction).toBe('getAuthorizationHeader');
		expect(c.shapeUrl).toBe('/v1/shape');
		expect(c.useTableParam).toBe(true);
		expect(c.columnMapper).toBe('snakeCamelMapper');
		expect(c.columnMapperNeedsCall).toBe(true);
		expect(c.apiUrl).toBe('/api');
		expect(c.apiBaseUrlImport).toBeNull();
		expect(c.parsers).toEqual({ timestamptz: '(date: string) => new Date(date)' });
		expect(c.architecture).toBe('clean');
	});

	it('resolves location defaults (dbEntities + collections auth import)', () => {
		const c = mapFrontendEmitConfig({});
		expect(c.dbEntitiesImport).toBe('@repo/db/entities');
		expect(c.authImport).toBe('@/lib/collections/auth');
	});
});

describe('mapFrontendEmitConfig — auth null-disables convention', () => {
	it('keeps an explicit auth.function string', () => {
		const c = mapFrontendEmitConfig({ frontend: { auth: { function: 'getToken' } } });
		expect(c.authFunction).toBe('getToken');
	});

	it('DISABLES auth when auth.function is explicit null (present-but-null)', () => {
		const c = mapFrontendEmitConfig({ frontend: { auth: { function: null } } });
		expect(c.authFunction).toBeNull();
	});

	it('defaults auth.function when the auth block is absent but frontend present', () => {
		const c = mapFrontendEmitConfig({ frontend: { parsers: {} } });
		expect(c.authFunction).toBe('getAuthorizationHeader');
	});
});

describe('mapFrontendEmitConfig — sync overrides', () => {
	it('threads every sync knob through', () => {
		const c = mapFrontendEmitConfig({
			frontend: {
				sync: {
					mode: 'api',
					shapeUrl: '/shapes',
					useTableParam: false,
					columnMapper: null,
					columnMapperNeedsCall: false,
					apiBaseUrlImport: '@/config/env',
					apiUrl: '/v2/api',
				},
			},
		});
		expect(c.globalSyncMode).toBe('api');
		expect(c.shapeUrl).toBe('/shapes');
		expect(c.useTableParam).toBe(false);
		expect(c.columnMapper).toBeNull();
		expect(c.columnMapperNeedsCall).toBe(false);
		expect(c.apiBaseUrlImport).toBe('@/config/env');
		expect(c.apiUrl).toBe('/v2/api');
	});

	it('lets columnMapper be disabled (null) independently of the default', () => {
		const c = mapFrontendEmitConfig({ frontend: { sync: { columnMapper: null } } });
		expect(c.columnMapper).toBeNull();
	});
});

describe('mapFrontendEmitConfig — architecture + locations', () => {
	it('passes clean-lite-ps through from generate.architecture', () => {
		const c = mapFrontendEmitConfig({ generate: { architecture: 'clean-lite-ps' } });
		expect(c.architecture).toBe('clean-lite-ps');
	});

	it('defaults architecture to clean for any non-lite value', () => {
		expect(mapFrontendEmitConfig({}).architecture).toBe('clean');
		expect(
			mapFrontendEmitConfig({ generate: { architecture: 'clean' } }).architecture,
		).toBe('clean');
	});

	it('honors a dbEntities import override from locations', () => {
		const c = mapFrontendEmitConfig({
			locations: { dbEntities: { path: 'db/entities', import: '@db/entities' } },
		});
		expect(c.dbEntitiesImport).toBe('@db/entities');
	});

	it('honors a frontendCollectionsAuth import override from locations', () => {
		const c = mapFrontendEmitConfig({
			locations: { frontendCollectionsAuth: { import: '@/auth' } },
		});
		expect(c.authImport).toBe('@/auth');
	});
});

describe('mapFrontendEmitConfig — invalid frontend block falls back to defaults', () => {
	it('does not throw on an unknown key; returns full defaults', () => {
		// `.strict()` rejects the unknown key — the mapper falls back to defaults
		// rather than throwing (the loader surfaces the warning separately).
		const c = mapFrontendEmitConfig({ frontend: { bogus: true } });
		expect(c.globalSyncMode).toBe('electric');
		expect(c.authFunction).toBe('getAuthorizationHeader');
	});
});

describe('mapFrontendEmitConfig — frontend.fields.textareaThreshold', () => {
	it('absent frontend.fields ⇒ textareaThreshold defaults to 500', () => {
		const c = mapFrontendEmitConfig({});
		expect(c.textareaThreshold).toBe(500);
	});

	it('absent frontend block ⇒ textareaThreshold defaults to 500', () => {
		const c = mapFrontendEmitConfig({ frontend: {} });
		expect(c.textareaThreshold).toBe(500);
	});

	it('explicit null survives (no default-stomping — present-but-null disables)', () => {
		const c = mapFrontendEmitConfig({
			frontend: { fields: { textareaThreshold: null } },
		});
		expect(c.textareaThreshold).toBeNull();
	});

	it('custom number passes through unchanged', () => {
		const c = mapFrontendEmitConfig({
			frontend: { fields: { textareaThreshold: 2000 } },
		});
		expect(c.textareaThreshold).toBe(2000);
	});
});

describe('loadFrontendEmitContext — registry + parsed loading', () => {
	it('loads the fixture entity set, sorted by name, with a parsed map', () => {
		const r = loadFrontendEmitContext(FIXTURES, {}, { entitiesDir: FIXTURES });
		expect(r.skip).toBeUndefined();
		if (r.skip !== undefined) return;

		const names = r.ctx.entities.map((e) => e.name);
		// name-sorted, includes the explicit-plural person fixture
		expect(names).toEqual([...names].sort());
		expect(names).toContain('person');
		// person.yaml declares `plural: persons` explicitly — registry must carry it
		const person = r.ctx.entities.find((e) => e.name === 'person');
		expect(person?.plural).toBe('persons');
		// parsed map is keyed by name and covers the registry set
		expect(r.ctx.parsed.has('user')).toBe(true);
	});

	it('resolves outDir from locations.frontendGenerated (default)', () => {
		const r = loadFrontendEmitContext(FIXTURES, {}, { entitiesDir: FIXTURES });
		if (r.skip !== undefined) return;
		expect(r.outDir).toBe(resolve(FIXTURES, 'apps/frontend/src/generated'));
	});

	it('honors a frontendGenerated path override', () => {
		const r = loadFrontendEmitContext(
			FIXTURES,
			{ locations: { frontendGenerated: { path: 'web/gen', import: '@web/gen' } } },
			{ entitiesDir: FIXTURES },
		);
		if (r.skip !== undefined) return;
		expect(r.outDir).toBe(resolve(FIXTURES, 'web/gen'));
	});
});

describe('loadFrontendEmitContext — zero entities skips', () => {
	it('returns a skip reason when the entities dir has no YAML', () => {
		const empty = resolve(import.meta.dir, '__no_such_entities_dir__');
		const r = loadFrontendEmitContext(empty, {}, { entitiesDir: empty });
		expect(r.skip).toBeDefined();
		expect(r.ctx).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// entity.frontend: false — per-entity frontend-exclude knob
// ---------------------------------------------------------------------------

describe('loadFrontendEmitContext — entity.frontend:false excludes from the emit set', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'frontend-exclude-'));
		// A normal entity (frontend emitted by default) ...
		writeFileSync(
			join(dir, 'deal.yaml'),
			`entity:
  name: deal
  plural: deals
  table: deals
fields:
  name: { type: string, required: true, max_length: 200 }
`,
			'utf-8',
		);
		// ... and a route-blocked SECRET entity that opts OUT of the frontend.
		writeFileSync(
			join(dir, 'auth_session.yaml'),
			`entity:
  name: auth_session
  plural: auth_sessions
  table: auth_sessions
  frontend: false
fields:
  token: { type: string, required: true, max_length: 200 }
`,
			'utf-8',
		);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('drops the frontend:false entity from the emit set but keeps the normal one', () => {
		const r = loadFrontendEmitContext(dir, {}, { entitiesDir: dir });
		expect(r.skip).toBeUndefined();
		if (r.skip !== undefined) return;

		const names = r.ctx.entities.map((e) => e.name);
		expect(names).toContain('deal');
		expect(names).not.toContain('auth_session');
		// the parsed map is filtered to the kept set too (no incidental lookups)
		expect(r.ctx.parsed.has('deal')).toBe(true);
		expect(r.ctx.parsed.has('auth_session')).toBe(false);
	});

	it('produces no store entry / full-fetch / resolver entry for the excluded entity', () => {
		const r = loadFrontendEmitContext(dir, {}, { entitiesDir: dir });
		if (r.skip !== undefined) throw new Error(r.skip);

		// The excluded entity must not appear in the store full-fetch/lookup set ...
		const fullFetch = lookupFullFetchNames(r.ctx);
		expect(fullFetch.has('deal')).toBe(true);
		expect(fullFetch.has('auth_session')).toBe(false);

		// ... nor anywhere in the generated store index or resolvers (no dangling
		// import, no `authSessions:` entry, no `authSessionApi.listAll()` call).
		const storeIndex = buildStoreIndexFile(r.ctx);
		const resolvers = buildResolversFile(r.ctx);
		expect(storeIndex).toContain('deals:');
		expect(storeIndex).not.toContain('authSession');
		expect(resolvers).not.toContain('authSession');
		// deal IS full-fetched (no unbounded text column) so its listAll() is present —
		// proving the resolver wiring works while the excluded entity is fully absent.
		expect(resolvers).toContain('dealApi.listAll()');
	});

	it('a normal entity is still fully wired when a sibling is excluded', () => {
		const r = loadFrontendEmitContext(dir, {}, { entitiesDir: dir });
		if (r.skip !== undefined) throw new Error(r.skip);
		const storeIndex = buildStoreIndexFile(r.ctx);
		// deal's hooks/collection/fields are imported and registered by plural.
		expect(storeIndex).toContain("import { dealHooks } from '../entities/deal';");
		expect(storeIndex).toContain('deals: dealHooks,');
	});
});
