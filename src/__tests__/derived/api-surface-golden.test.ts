/**
 * API-surface golden (ADR-046, PLAN §7.2) — pins what parity cannot see: kinds, flags, `origin` and `shadows`,
 * `delegatesTo`, parameter names, result shapes. Parity compares names and routes; a change that keeps every
 * name but moves provenance or shape (a finder losing `unique:`) is caught here.
 *
 * One JSON per baseline fixture entity (`<entity>.json`) and per render-matrix case (`<case id>.json`) under
 * `test/api-surface-golden/snapshot/`. Frozen for all of Phase B: templates move, the derivation does not.
 *
 * Regenerate after an intentional derivation change:
 *   UPDATE_API_SURFACE_GOLDEN=1 bun test src/__tests__/derived/api-surface-golden.test.ts
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { baselineSet, deriveSet, REPO_ROOT } from './_inputs';
import { RENDER_MATRIX } from './_render-matrix';

const SNAPSHOT_DIR_REL = 'test/api-surface-golden/snapshot';
const SNAPSHOT_DIR = join(REPO_ROOT, SNAPSHOT_DIR_REL);
const UPDATE = process.env.UPDATE_API_SURFACE_GOLDEN === '1';

/** Every snapshot, by name: the baseline entities, then the matrix cases. */
function current(): Map<string, unknown> {
	const out = new Map<string, unknown>();
	for (const [name, surface] of deriveSet(baselineSet())) out.set(name, surface);
	for (const c of RENDER_MATRIX) {
		const surfaces = deriveSet(c);
		out.set(c.id, {
			case: c.id,
			covers: c.covers,
			entities: Object.fromEntries(c.subjects.map((s) => [s, surfaces.get(s)])),
		});
	}
	return out;
}

const render = (value: unknown) => `${JSON.stringify(value, null, '\t')}\n`;

describe('api-surface golden', () => {
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

	it('covers the 9 baseline entities and every matrix case, and nothing else', () => {
		expect(snapshots.size).toBe(9 + RENDER_MATRIX.length);
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
