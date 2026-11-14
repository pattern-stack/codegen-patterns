/**
 * API-surface golden, whole-set half (ADR-046, PLAN §7.2) — pins what the link pass adds over the per-entity
 * surfaces `api-surface-golden.test.ts` already pins: `relations` (pairing, `generates`, `includeKeys`),
 * `unmodelled`, `warnings`, and each entity's attached `http.includes`.
 *
 * One JSON per set under `test/api-surface-golden/project/`: `baseline.json` (the baseline fixture set) and
 * `<case id>.json` per render-matrix case. Kept apart from `snapshot/` so the per-entity files stay exactly as A1
 * pinned them. Frozen for all of Phase B, like `snapshot/`.
 *
 * Regenerate after an intentional derivation change:
 *   UPDATE_API_SURFACE_GOLDEN=1 bun test src/__tests__/derived/api-surface-project-golden.test.ts
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ProjectApiSurface } from '../../derived/api/types';
import { REPO_ROOT } from './_inputs';
import { deriveBaselineProject, deriveProjectFromSet } from './_project';
import { RENDER_MATRIX } from './_render-matrix';

const SNAPSHOT_DIR_REL = 'test/api-surface-golden/project';
const SNAPSHOT_DIR = join(REPO_ROOT, SNAPSHOT_DIR_REL);
const UPDATE = process.env.UPDATE_API_SURFACE_GOLDEN === '1';

/** What the whole-set pass adds — the per-entity rest is `snapshot/`'s. */
function linkPass(p: ProjectApiSurface) {
	return {
		relations: p.relations,
		unmodelled: p.unmodelled,
		warnings: p.warnings,
		includes: Object.fromEntries(
			Object.values(p.entities)
				.filter((e) => e.http.includes !== undefined)
				.map((e) => [e.entity, e.http.includes]),
		),
	};
}

function current(): Map<string, unknown> {
	const out = new Map<string, unknown>();
	out.set('baseline', linkPass(deriveBaselineProject()));
	for (const c of RENDER_MATRIX) out.set(c.id, { case: c.id, covers: c.covers, ...linkPass(deriveProjectFromSet(c)) });
	return out;
}

const render = (value: unknown) => `${JSON.stringify(value, null, '\t')}\n`;

describe('api-surface project golden', () => {
	const snapshots = current();

	if (UPDATE) {
		it('regenerates the checked-in snapshots', () => {
			mkdirSync(SNAPSHOT_DIR, { recursive: true });
			for (const f of readdirSync(SNAPSHOT_DIR)) {
				if (!snapshots.has(f.replace(/\.json$/, ''))) throw new Error(`stale snapshot ${f}: delete it by hand`);
			}
			for (const [name, value] of snapshots) writeFileSync(join(SNAPSHOT_DIR, `${name}.json`), render(value));
			expect(readdirSync(SNAPSHOT_DIR)).toHaveLength(snapshots.size);
		});
		return;
	}

	it('covers the baseline set and every matrix case, and nothing else', () => {
		expect(snapshots.size).toBe(1 + RENDER_MATRIX.length);
		const onDisk = existsSync(SNAPSHOT_DIR) ? readdirSync(SNAPSHOT_DIR).sort() : [];
		expect(onDisk).toEqual([...snapshots.keys()].map((n) => `${n}.json`).sort());
	});

	for (const [name, value] of snapshots) {
		it(`${name} matches its snapshot`, () => {
			const file = join(SNAPSHOT_DIR, `${name}.json`);
			const expected = existsSync(file) ? readFileSync(file, 'utf-8') : null;
			const message = `api-surface golden: \`${name}\` differs from ${SNAPSHOT_DIR_REL}/${name}.json`;
			if (expected !== render(value)) {
				throw new Error(`${message}\n${expected === null ? '(no snapshot file)' : diffHint(expected, render(value))}`);
			}
		});
	}
});

/** The first differing line, so a red run says where without a full dump. */
function diffHint(expected: string, actual: string): string {
	const a = expected.split('\n');
	const b = actual.split('\n');
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if (a[i] !== b[i]) return `first difference at line ${i + 1}:\n  snapshot: ${a[i] ?? '<end>'}\n  derived:  ${b[i] ?? '<end>'}`;
	}
	return '';
}
