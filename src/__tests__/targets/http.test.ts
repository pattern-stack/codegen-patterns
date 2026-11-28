/**
 * `HTTP_LAYERS` (H-1b): one row per `target.http` value, read through `rowFor`; the renderers have one per layer.
 */
import { describe, expect, it } from 'bun:test';
import { TARGET_HTTPS } from '../../targets/apps';
import { HTTP_LAYERS, patternStackHttpLayer, patternStackHttpName } from '../../targets/http';
import { HTTP_RENDERERS } from '../../emitters/http';

describe('HTTP_LAYERS', () => {
	it('has a row for every http value, and renderers for every layer', () => {
		expect(Object.keys(HTTP_LAYERS).sort()).toEqual([...TARGET_HTTPS].sort());
		const layers = Object.entries(HTTP_LAYERS).filter(([, l]) => l !== null).map(([k]) => k);
		expect(Object.keys(HTTP_RENDERERS).sort()).toEqual(layers.sort());
	});

	it('gives pattern-stack/hono its layer, and none none', () => {
		expect(patternStackHttpLayer({ wiring: 'pattern-stack', http: 'hono' })).toBe(HTTP_LAYERS.hono);
		expect(patternStackHttpName({ wiring: 'pattern-stack', http: 'hono' })).toBe('hono');
		expect(patternStackHttpLayer({ wiring: 'pattern-stack' })).toBeNull();
		expect(patternStackHttpName({ wiring: 'pattern-stack', http: 'none' })).toBeNull();
	});

	it("declares the port as the layer's setting", () => {
		expect(HTTP_LAYERS.hono.settings).toEqual([expect.objectContaining({ group: 'http', key: 'port', env: 'PORT', default: '3000' })]);
	});
});

describe('the Hono app file', () => {
	it('mounts each entity on its module and serves the document', () => {
		const text = HTTP_RENDERERS.hono.appFile({
			banner: '// banner',
			entities: [{ module: 'crm', key: 'contact', routesFunction: 'contactRoutes', registerPathsFunction: 'registerContactPaths', routesImport: '../modules/crm/contacts/contact.routes' }],
			runtimeImport: '@shared/http/hono',
			openApiImport: '@shared/openapi',
		});
		expect(text).toContain("import { registerContactPaths, contactRoutes } from '../modules/crm/contacts/contact.routes';");
		expect(text).toContain("http.route('/', contactRoutes(app.module('crm').contact.useCases));");
		expect(text).toContain("http.get(`${docs.path}-json`");
		expect(text).toContain("if (docs.auth === 'bearer') openApi.registerSecurityScheme('bearer'");
		expect(text).toContain('useNestFallbacks(http);');
		expect(text).toContain('    registerContactPaths(openApi);');
	});
});
