/**
 * The parity comparator, tested on its own (#726 shape (a)): each disagreement produces exactly its PLAN §7.1
 * message, an agreement produces none, and an absent or empty input is a failure — never a silent pass
 * (#726 shape (c)).
 */

import { describe, expect, it } from 'bun:test';

import type { EntityApiSurface } from '../../derived/api/types';
import { compareEntity, type GeneratedEntity, type ParsedClass } from './_parity-compare';

function surface(over: Partial<EntityApiSurface> = {}): EntityApiSurface {
	return {
		entity: 'widget',
		plural: 'widgets',
		className: 'Widget',
		repository: {
			className: 'WidgetRepository',
			baseClass: 'BaseRepository',
			typedInclude: false,
			methods: [
				{ name: 'findById', kind: 'find_by_id', emitted: true, params: [], returns: 'one', readOptions: 'columns', origin: { from: 'base' } },
				{ name: 'exists', kind: 'inherited', emitted: false, params: [], returns: 'forwarded', readOptions: 'none', origin: { from: 'pattern', pattern: 'Base' } },
			],
		},
		service: {
			className: 'WidgetService',
			baseClass: 'BaseService',
			methods: [{ name: 'findById', kind: 'read', emitted: true, params: [], returns: 'one', origin: { from: 'base' } }],
		},
		useCases: [{ className: 'FindWidgetByIdUseCase', kind: 'find_by_id', calls: { entity: 'widget', layer: 'service', method: 'findById' }, origin: { from: 'base' } }],
		http: {
			enabled: true,
			routes: [
				{ verb: 'GET', path: '/widgets/:id', controller: 'WidgetController', handler: 'getById', useCase: 'FindWidgetByIdUseCase', origin: { from: 'base' } },
			],
			includeRoutes: [],
			includesConst: 'WIDGETS_API_INCLUDES',
		},
		...over,
	};
}

const cls = (name: string, methods: string[], extra: Partial<ParsedClass> = {}): ParsedClass => ({ name, exported: true, methods, ...extra });

function generated(over: Partial<GeneratedEntity> = {}): GeneratedEntity {
	return {
		repository: { file: 'm/widget.repository.ts', classes: [cls('WidgetRepository', ['findById'])] },
		service: { file: 'm/widget.service.ts', classes: [cls('WidgetService', ['findById'])] },
		controllers: [
			{
				className: 'WidgetController',
				file: 'm/widget.controller.ts',
				classes: [cls('WidgetController', ['getById'], { controllerPrefix: 'widgets', routes: [{ verb: 'GET', subPath: ':id' }] })],
			},
			{ className: 'WidgetSearchController', file: 'm/widget-search.controller.ts', classes: null },
		],
		useCases: { dir: 'm/use-cases', files: [{ file: 'm/use-cases/find.ts', classes: [cls('FindWidgetByIdUseCase', ['execute'])] }] },
		baseChains: {
			repository: [{ name: 'BaseRepository', methods: new Set(['exists']) }],
			service: [{ name: 'BaseService', methods: new Set() }],
		},
		...over,
	};
}

describe('api-surface parity comparator', () => {
	it('agreement is no message', () => {
		expect(compareEntity(surface(), generated())).toEqual([]);
	});

	it('a generated method the derivation does not list', () => {
		const g = generated({ repository: { file: 'm/widget.repository.ts', classes: [cls('WidgetRepository', ['findById', 'findRecent'])] } });
		expect(compareEntity(surface(), g)).toEqual([
			'api-surface parity: WidgetRepository declares `findRecent`, which the derived API surface does not list',
		]);
	});

	it('a derived method no file declares', () => {
		const g = generated({ service: { file: 'm/widget.service.ts', classes: [cls('WidgetService', [])] } });
		expect(compareEntity(surface(), g)).toEqual([
			'api-surface parity: the derived API surface lists `WidgetService.findById`, which m/widget.service.ts does not declare',
		]);
	});

	it('a generated route the derivation does not list, and the derived route it replaced', () => {
		const g = generated();
		g.controllers[0]!.classes = [
			cls('WidgetController', ['getById'], { controllerPrefix: 'widgets', routes: [{ verb: 'GET', subPath: ':key' }] }),
		];
		expect(compareEntity(surface(), g)).toEqual([
			'api-surface parity: WidgetController declares route `GET /widgets/:key`, which the derived API surface does not list',
			'api-surface parity: the derived API surface lists route `GET /widgets/:id`, which m/widget.controller.ts does not declare',
		]);
	});

	it('an inherited method no class of the base chain declares', () => {
		const g = generated({
			baseChains: {
				repository: [
					{ name: 'IntegratedEntityRepository', methods: new Set() },
					{ name: 'BaseRepository', methods: new Set() },
				],
				service: [],
			},
		});
		expect(compareEntity(surface(), g)).toEqual([
			'api-surface parity: WidgetRepository lists `exists` as inherited, but no class in its base chain (IntegratedEntityRepository → BaseRepository) declares it',
		]);
	});

	it('an absent file is a failure, not an empty set', () => {
		const g = generated({ service: { file: 'm/widget.service.ts', classes: null } });
		expect(compareEntity(surface(), g)).toEqual(['api-surface parity: no generated file for `widget` at m/widget.service.ts']);
	});

	it('a file that parses to no class is a failure', () => {
		const g = generated({ repository: { file: 'm/widget.repository.ts', classes: [] } });
		expect(compareEntity(surface(), g)).toEqual(['api-surface parity: m/widget.repository.ts parsed to 0 classes']);
	});

	it('an absent use-case folder is a failure', () => {
		const g = generated({ useCases: { dir: 'm/use-cases', files: [] } });
		expect(compareEntity(surface(), g)).toEqual(['api-surface parity: no generated file for `widget` at m/use-cases']);
	});

	it('use cases compare both ways; a non-exported class is not a use case', () => {
		const g = generated({
			useCases: {
				dir: 'm/use-cases',
				files: [{ file: 'm/use-cases/x.ts', classes: [cls('ListWidgetsUseCase', []), { ...cls('Helper', []), exported: false }] }],
			},
		});
		expect(compareEntity(surface(), g)).toEqual([
			'api-surface parity: m/use-cases/x.ts declares use case `ListWidgetsUseCase`, which the derived API surface does not list',
			'api-surface parity: the derived API surface lists use case `FindWidgetByIdUseCase`, which m/use-cases does not declare',
		]);
	});

	it('HTTP off: an emitted controller is a failure', () => {
		const off = surface();
		off.http = { ...off.http, enabled: false, routes: [] };
		expect(compareEntity(off, generated())).toEqual([
			'api-surface parity: the derived API surface has HTTP off for `widget`, but m/widget.controller.ts exists',
		]);
	});

	it('HTTP on: an absent controller is a failure', () => {
		const g = generated();
		g.controllers[0]!.classes = null;
		expect(compareEntity(surface(), g)).toEqual([
			'api-surface parity: no generated file for `widget` at m/widget.controller.ts',
			'api-surface parity: the derived API surface lists route `GET /widgets/:id`, which m/widget.controller.ts does not declare',
		]);
	});
});
