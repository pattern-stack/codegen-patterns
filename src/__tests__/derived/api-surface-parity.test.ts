/**
 * API-surface parity (ADR-046, PLAN §7.1) — the derived API surface equals what the generator really emits.
 *
 * Per entity, set equality in both directions over the repository's and the service's public methods, the
 * use-case classes and the HTTP routes; every `emitted: false` method must be declared somewhere on its class's
 * base chain (`runtime/base-classes/`, plus the capability mixins).
 *
 * - **Subject A — the checked-in baseline.** Derived from `test/fixtures/entities` under the baseline's own
 *   config; compared with `test/baseline/` (which `just test-baseline` holds equal to what the generator emits).
 * - **Subject B — the render matrix** (`_render-matrix.ts`): the shapes the baseline lacks, rendered in-process
 *   through the real templates.
 *
 * A template that emits a method, use case or route the derivation does not list fails here; so does a
 * derivation that lists one no template emits. The comparator is `_parity-compare.ts`, tested on its own.
 */

import { describe, expect, it } from 'bun:test';

import { resolvePatternComposition } from '../../../templates/entity/new/backend/entity-locals.js';
import { searchControllerClassName } from '../../derived/api/names';
import type { EntityBlockInput } from '../../derived/api/entity';
import type { EntityApiSurface } from '../../derived/api/types';
import { compareEntity } from './_parity-compare';
import { diskTree, memoryTree, readGeneratedEntity, type GeneratedTree } from './_generated-files';
import { BASELINE_ROOT, baselineModulesDir, baselineSet, deriveSet } from './_inputs';
import { RENDER_MATRIX } from './_render-matrix';
import { RENDER_MODULES_DIR, renderEntities } from './_render';

/**
 * A named expectation, shaped like the #680 one (`test/run-test.ts`): exact case, exact messages, asserted
 * present AND sole.
 *
 * The Metadata pattern declares `listByEntityId` / `listHistoryByEntityId` as inherited by the SERVICE
 * (`src/patterns/library/metadata.pattern.ts`), but `MetadataEntityService` declares `listByEntity` /
 * `listHistory` — those two names exist only on `MetadataEntityRepository`. The derivation lists what the
 * pattern declares; parity reports that the base chain does not have them.
 *
 * Unfiled — drafted in the S1 packet; when metadata.pattern.ts is corrected this fails and must be deleted.
 */
const METADATA_INHERITED_EXPECTATION = {
	caseId: 'matrix-eav-value-table',
	entity: 'field_value',
	messages: [
		'api-surface parity: FieldValueService lists `listByEntityId` as inherited, but no class in its base chain (MetadataEntityService → BaseService) declares it',
		'api-surface parity: FieldValueService lists `listHistoryByEntityId` as inherited, but no class in its base chain (MetadataEntityService → BaseService) declares it',
	],
} as const;

function expectedDisagreements(caseId: string, entity: string): readonly string[] {
	return caseId === METADATA_INHERITED_EXPECTATION.caseId && entity === METADATA_INHERITED_EXPECTATION.entity
		? METADATA_INHERITED_EXPECTATION.messages
		: [];
}

function disagreements(
	surface: EntityApiSurface,
	entity: EntityBlockInput,
	tree: GeneratedTree,
	modulesDir: string,
): string[] {
	const generated = readGeneratedEntity(tree, entity, modulesDir, resolvePatternComposition(entity), {
		controller: surface.http.routes.find((r) => r.handler === 'getAll')?.controller ?? `${surface.className}Controller`,
		searchController: searchControllerClassName(surface.entity),
	});
	return compareEntity(surface, generated);
}

describe('api-surface parity — Subject A: the checked-in baseline', () => {
	const set = baselineSet();
	const surfaces = deriveSet(set);
	const modulesDir = baselineModulesDir();
	const tree = diskTree(BASELINE_ROOT);

	it('derives every baseline fixture entity (guards against an empty sweep)', () => {
		expect([...surfaces.keys()].sort()).toEqual([
			'account',
			'contact',
			'deal',
			'deal_state',
			'opportunity',
			'organization',
			'person',
			'tenant',
			'user',
		]);
	});

	for (const definition of set.entities) {
		const name = definition.entity.name;
		it(`${name}: the derived surface is what test/baseline declares`, () => {
			const surface = surfaces.get(name);
			expect(surface).toBeDefined();
			expect(disagreements(surface!, definition.entity, tree, modulesDir)).toEqual([]);
		});
	}
});

describe('api-surface parity — Subject B: the render matrix', () => {
	it('the Metadata expectation names a real case and subject', () => {
		const c = RENDER_MATRIX.find((m) => m.id === METADATA_INHERITED_EXPECTATION.caseId);
		expect(c?.subjects).toContain(METADATA_INHERITED_EXPECTATION.entity);
	});

	for (const matrixCase of RENDER_MATRIX) {
		const surfaces = deriveSet(matrixCase);
		const tree = memoryTree(renderEntities(matrixCase, matrixCase.subjects));
		for (const name of matrixCase.subjects) {
			it(`${matrixCase.id} · ${name}: the derived surface is what the templates render`, () => {
				const definition = matrixCase.entities.find((d) => d.entity.name === name);
				const surface = surfaces.get(name);
				expect(definition).toBeDefined();
				expect(surface).toBeDefined();
				// Exact equality: a named expectation's messages must all be present and be the only ones.
				expect(disagreements(surface!, definition!.entity, tree, RENDER_MODULES_DIR)).toEqual([
					...expectedDisagreements(matrixCase.id, name),
				]);
			});
		}
	}
});
