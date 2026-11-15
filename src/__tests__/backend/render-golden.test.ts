/**
 * Render-matrix byte goldens (ADR-046 Phase B, PLAN §9 B1) — the safety net for "the templates print".
 *
 * `just test-baseline` proves Phase B's "no behaviour change" only for the shapes the baseline fixtures
 * exercise, and the baseline has no EAV, no capability forwarder, no composed base, no `api: false`, no
 * `api.includes` wiring and no `generate.writes: false` (PLAN F2). This test pins the bytes of those shapes.
 *
 * Every render-matrix case (`../derived/_render-matrix.ts`) is rendered for EVERY entity of its set through the
 * same in-process path the API-surface parity gate uses (`../derived/_render.ts`'s `renderAllBackendFiles`:
 * `buildBackendLocals` + the prompt's locals + `ejs.render` over EVERY `*.ejs.t` under
 * `templates/entity/new/backend` — entity, module, index, DTOs, composed base, integration source, repository,
 * service, controllers, use cases), and
 * compared with `test/render-golden/<case>/<project-relative path>` byte for byte, in both directions: a file
 * rendered but not snapshotted fails, a snapshot with no rendered file fails, and a case that renders nothing
 * fails. Every failure names the case and the file.
 *
 * Regenerate only after an intentional template change (never in Phase B, where these are frozen):
 *   UPDATE_RENDER_GOLDEN=1 bun test src/__tests__/backend/render-golden.test.ts
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { RENDER_MATRIX } from '../derived/_render-matrix';
import { renderAllBackendFiles } from '../derived/_render';

const GOLDEN_ROOT = resolve(import.meta.dir, '../../../test/render-golden');
const UPDATE = process.env.UPDATE_RENDER_GOLDEN === '1';

/** Every file under `dir`, as `/`-separated paths relative to it, sorted. */
function walk(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const visit = (d: string): void => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) visit(p);
			else out.push(relative(dir, p).split(sep).join('/'));
		}
	};
	visit(dir);
	return out.sort();
}

/** What the case renders: every entity of its set, path → text. */
function render(caseId: string): Map<string, string> {
	const c = RENDER_MATRIX.find((x) => x.id === caseId);
	if (!c) throw new Error(`render-golden: no matrix case '${caseId}'`);
	return renderAllBackendFiles(
		c,
		c.entities.map((d) => d.entity.name),
	);
}

describe('render-matrix byte goldens', () => {
	it('covers every matrix case and no other (guards against a silently empty sweep)', () => {
		expect(RENDER_MATRIX.length).toBeGreaterThan(0);
		if (UPDATE) return;
		const dirs = readdirSync(GOLDEN_ROOT, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
		expect(dirs).toEqual(RENDER_MATRIX.map((c) => c.id).sort());
	});

	for (const c of RENDER_MATRIX) {
		const caseDir = join(GOLDEN_ROOT, c.id);

		if (UPDATE) {
			it(`${c.id}: regenerates the snapshot`, () => {
				const files = render(c.id);
				expect(files.size, `render-golden: ${c.id} rendered 0 files`).toBeGreaterThan(0);
				rmSync(caseDir, { recursive: true, force: true });
				for (const [path, text] of files) {
					const target = join(caseDir, path);
					mkdirSync(dirname(target), { recursive: true });
					writeFileSync(target, text);
				}
			});
			continue;
		}

		describe(c.id, () => {
			const files = render(c.id);
			const rendered = [...files.keys()].sort();
			const snapshotted = walk(caseDir);

			it('renders at least one file', () => {
				expect(files.size, `render-golden: ${c.id} rendered 0 files`).toBeGreaterThan(0);
			});

			it('renders exactly the snapshotted files', () => {
				const snap = new Set(snapshotted);
				const ren = new Set(rendered);
				const problems = [
					...rendered
						.filter((p) => !snap.has(p))
						.map((p) => `render-golden: ${c.id} renders ${p}, which test/render-golden/${c.id}/ does not snapshot`),
					...snapshotted
						.filter((p) => !ren.has(p))
						.map((p) => `render-golden: test/render-golden/${c.id}/${p} is snapshotted, but ${c.id} does not render it`),
				];
				expect(problems).toEqual([]);
			});

			it('is byte-identical to the snapshot, file by file', () => {
				const differing = rendered
					.filter((p) => snapshotted.includes(p))
					.filter((p) => files.get(p) !== readFileSync(join(caseDir, p), 'utf-8'))
					.map((p) => `render-golden: ${c.id} renders ${p} differently from test/render-golden/${c.id}/${p}`);
				expect(differing).toEqual([]);
			});

			it('renders the same bytes twice (deterministic)', () => {
				const again = render(c.id);
				expect([...again.keys()].sort()).toEqual(rendered);
				for (const p of rendered) expect({ case: c.id, file: p, same: again.get(p) === files.get(p) }).toEqual({ case: c.id, file: p, same: true });
			});
		});
	}
});
