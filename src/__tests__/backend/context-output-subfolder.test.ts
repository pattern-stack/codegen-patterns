/**
 * #403 — `context:` drives the generated module output subfolder (backend).
 *
 * Verifies the central resolver (`buildBackendLocals` →
 * `outputPaths` + `moduleDir`):
 *   - A top-level `context:` nests EVERY module file under
 *     `<src>/modules/<context>/<plural>/…`.
 *   - An untagged entity stays flat (`<src>/modules/<plural>/…`) — byte-identical
 *     to pre-#403 output (baseline protection).
 *   - `context` is surfaced for templates (null when untagged).
 *
 * Folder-grouping ONLY: this exercise asserts paths, not table/column names —
 * those are unchanged by `context:` (ADR-0004's prefix→schema flip stays deferred).
 */

import { describe, it, expect } from 'bun:test';
import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';

const SRC = 'app/backend/src';

function localsFor(entityExtra: Record<string, unknown>) {
	const definition = {
		entity: {
			name: 'transcript',
			plural: 'transcripts',
			table: 'transcripts',
			// #403: `context:` lives inside the `entity:` block (0.12.2).
			...entityExtra,
		},
		fields: { title: { type: 'string', required: true } },
		relationships: {},
		behaviors: ['timestamps'],
	};
	return buildBackendLocals(definition, { modulesDir: `${SRC}/modules` });
}

describe('#403 backend — context nests module output paths', () => {
	it('prefixes every outputPaths entry with modules/<context>/<plural>/', () => {
		const { outputPaths, context } = localsFor({ context: 'integration' });

		expect(context).toBe('integration');

		const base = `${SRC}/modules/integration/transcripts`;
		expect(outputPaths.entity).toBe(`${base}/transcript.entity.ts`);
		expect(outputPaths.repository).toBe(`${base}/transcript.repository.ts`);
		expect(outputPaths.service).toBe(`${base}/transcript.service.ts`);
		expect(outputPaths.controller).toBe(`${base}/transcript.controller.ts`);
		expect(outputPaths.module).toBe(`${base}/transcripts.module.ts`);
		expect(outputPaths.index).toBe(`${base}/index.ts`);
		expect(outputPaths.findByIdUseCase).toBe(
			`${base}/use-cases/find-transcript-by-id.use-case.ts`,
		);
		expect(outputPaths.createDto).toBe(`${base}/dto/create-transcript.dto.ts`);

		// Every emitted path lives under the context subfolder — no leaks to flat.
		for (const p of Object.values(outputPaths)) {
			if (typeof p === 'string') {
				expect(p.startsWith(`${SRC}/modules/integration/`)).toBe(true);
			}
		}
	});

	it('untagged entity stays flat (modules/<plural>/) — baseline unchanged', () => {
		const { outputPaths, context } = localsFor({});

		expect(context).toBeNull();

		const base = `${SRC}/modules/transcripts`;
		expect(outputPaths.entity).toBe(`${base}/transcript.entity.ts`);
		expect(outputPaths.module).toBe(`${base}/transcripts.module.ts`);
		expect(outputPaths.createDto).toBe(`${base}/dto/create-transcript.dto.ts`);

		// No `/modules/<context>/` segment ever appears for an untagged entity.
		for (const p of Object.values(outputPaths)) {
			if (typeof p === 'string') {
				expect(p.startsWith(`${SRC}/modules/transcripts/`)).toBe(true);
			}
		}
	});
});
