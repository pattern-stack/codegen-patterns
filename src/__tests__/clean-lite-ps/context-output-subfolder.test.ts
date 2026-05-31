/**
 * #403 — `context:` drives the generated module output subfolder (clean-lite-ps).
 *
 * Verifies the central resolver (`buildCleanLitePsLocals` →
 * `clpOutputPaths` + `moduleGroupDir`):
 *   - A top-level `context:` nests EVERY module file under
 *     `<src>/modules/<context>/<plural>/…`.
 *   - An untagged entity stays flat (`<src>/modules/<plural>/…`) — byte-identical
 *     to pre-#403 output (baseline protection).
 *   - `clpContext` is surfaced for templates (null when untagged).
 *
 * Folder-grouping ONLY: this exercise asserts paths, not table/column names —
 * those are unchanged by `context:` (ADR-0004's prefix→schema flip stays deferred).
 */

import { describe, it, expect } from 'bun:test';
import { buildCleanLitePsLocals } from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';

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
	return buildCleanLitePsLocals(definition, { backendSrc: SRC });
}

describe('#403 clean-lite-ps — context nests module output paths', () => {
	it('prefixes every clpOutputPaths entry with modules/<context>/<plural>/', () => {
		const { clpOutputPaths, clpContext } = localsFor({ context: 'integration' });

		expect(clpContext).toBe('integration');

		const base = `${SRC}/modules/integration/transcripts`;
		expect(clpOutputPaths.entity).toBe(`${base}/transcript.entity.ts`);
		expect(clpOutputPaths.repository).toBe(`${base}/transcript.repository.ts`);
		expect(clpOutputPaths.service).toBe(`${base}/transcript.service.ts`);
		expect(clpOutputPaths.controller).toBe(`${base}/transcript.controller.ts`);
		expect(clpOutputPaths.module).toBe(`${base}/transcripts.module.ts`);
		expect(clpOutputPaths.index).toBe(`${base}/index.ts`);
		expect(clpOutputPaths.findByIdUseCase).toBe(
			`${base}/use-cases/find-transcript-by-id.use-case.ts`,
		);
		expect(clpOutputPaths.createDto).toBe(`${base}/dto/create-transcript.dto.ts`);

		// Every emitted path lives under the context subfolder — no leaks to flat.
		for (const p of Object.values(clpOutputPaths)) {
			if (typeof p === 'string') {
				expect(p.startsWith(`${SRC}/modules/integration/`)).toBe(true);
			}
		}
	});

	it('untagged entity stays flat (modules/<plural>/) — baseline unchanged', () => {
		const { clpOutputPaths, clpContext } = localsFor({});

		expect(clpContext).toBeNull();

		const base = `${SRC}/modules/transcripts`;
		expect(clpOutputPaths.entity).toBe(`${base}/transcript.entity.ts`);
		expect(clpOutputPaths.module).toBe(`${base}/transcripts.module.ts`);
		expect(clpOutputPaths.createDto).toBe(`${base}/dto/create-transcript.dto.ts`);

		// No `/modules/<context>/` segment ever appears for an untagged entity.
		for (const p of Object.values(clpOutputPaths)) {
			if (typeof p === 'string') {
				expect(p.startsWith(`${SRC}/modules/transcripts/`)).toBe(true);
			}
		}
	});
});
