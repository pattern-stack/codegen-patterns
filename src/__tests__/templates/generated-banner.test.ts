/**
 * Generated-banner regression tests.
 *
 * Every force-overwritten codegen output must carry a `@generated` /
 * DO-NOT-EDIT banner as its first body line. Without it, a hand edit made
 * directly into a generated file looks permanent until the next re-emit
 * silently wipes it — the exact landmine that motivated this change.
 *
 * Coverage:
 *   1. The shared helper (`renderGeneratedBanner`) produces the contract
 *      wording, interpolates the source path, and supports the SQL leader.
 *   2. Every `force: true` `.ejs.t` template emits the banner as its first
 *      body line when a `generatedBanner` local is supplied — and degrades to
 *      nothing (no ReferenceError) when it is absent. The single banner line
 *      is `<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>`.
 *
 * The timestamped electric migration is the lone force template intentionally
 * excluded: its filename changes every emit, so it is never overwritten in
 * place and hand edits there are not at risk.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import ejs from 'ejs';
import {
	renderGeneratedBanner,
	GENERATED_BANNER_MARKER,
} from '../../../templates/_shared/generated-banner.mjs';

const TEMPLATES_ROOT = resolve(import.meta.dir, '../../../templates');

const EXCLUDED = new Set([
	// Timestamped filename — a fresh file each emit, never overwritten in place.
	'entity/new/backend/database/electric-migration.ejs.t',
]);

function walk(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, acc);
		else if (entry.name.endsWith('.ejs.t')) acc.push(full);
	}
	return acc;
}

function frontmatterAndBody(source: string): { frontmatter: string; body: string } {
	const lines = source.split('\n');
	if (lines[0] !== '---') return { frontmatter: '', body: source };
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === '---') {
			end = i;
			break;
		}
	}
	if (end === -1) return { frontmatter: '', body: source };
	return {
		frontmatter: lines.slice(1, end).join('\n'),
		body: lines.slice(end + 1).join('\n'),
	};
}

/** Force templates, relative to templates/, excluding the timestamped migration. */
function forceTemplates(): string[] {
	return walk(TEMPLATES_ROOT)
		.filter((abs) => {
			const { frontmatter } = frontmatterAndBody(readFileSync(abs, 'utf8'));
			return /(^|\n)force:\s*true/.test(frontmatter);
		})
		.map((abs) => relative(TEMPLATES_ROOT, abs))
		.filter((rel) => !EXCLUDED.has(rel))
		.sort();
}

describe('renderGeneratedBanner — shared helper', () => {
	it('stamps the marker, source, regenerate command, and seam', () => {
		const banner = renderGeneratedBanner({
			source: 'entities/opportunity.yaml',
			generator: 'entity',
			seam: 'the entity YAML',
		});

		expect(banner).toContain(GENERATED_BANNER_MARKER);
		expect(banner).toContain('from entities/opportunity.yaml');
		expect(banner).toContain('DO NOT EDIT');
		expect(banner).toContain('overwritten on re-emit');
		expect(banner).toContain('bun run codegen');
		expect(banner).toContain('To extend, use the entity YAML.');
		// Single line — banners are exactly one comment line.
		expect(banner).not.toContain('\n');
		expect(banner.startsWith('// ')).toBe(true);
	});

	it('falls back to the generator name when no source is given', () => {
		const banner = renderGeneratedBanner({ generator: 'broadcast' });
		expect(banner).toContain('(broadcast generator)');
		expect(banner).not.toContain('from ');
	});

	it('supports a SQL comment leader', () => {
		const banner = renderGeneratedBanner({ generator: 'entity', comment: '--' });
		expect(banner.startsWith('-- ')).toBe(true);
	});
});

describe('force templates carry the @generated banner', () => {
	const templates = forceTemplates();

	it('enumerates a non-trivial set of force templates', () => {
		// Guards against the walk silently matching nothing (e.g. a refactor
		// that moves the templates dir) and the suite passing vacuously.
		expect(templates.length).toBeGreaterThan(50);
	});

	const BANNER_LINE =
		"<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>";

	it.each(templates)('%s — banner is the first body line', (rel) => {
		const { body } = frontmatterAndBody(readFileSync(join(TEMPLATES_ROOT, rel), 'utf8'));

		// The guarded banner line is the FIRST line of the template body — i.e.
		// the first thing emitted into the generated file, ahead of any imports
		// or doc comments. (Single source of truth; not copy-pasted prose.)
		expect(body.split('\n')[0]).toBe(BANNER_LINE);
	});

	it.each(templates)('%s — banner line renders to the contract wording', (rel) => {
		const banner = renderGeneratedBanner({
			source: rel,
			generator: 'test',
			seam: 'the source definition',
		});

		// Render just the banner line in isolation (full bodies need richer
		// locals). With the local supplied it produces the marker line.
		const rendered = ejs
			.render(BANNER_LINE, { generatedBanner: banner }, { rmWhitespace: false })
			.trim();
		expect(rendered).toBe(banner);
		expect(rendered).toContain(GENERATED_BANNER_MARKER);
	});

	it.each(templates)('%s — renders without the local (graceful degradation)', (rel) => {
		const { body } = frontmatterAndBody(readFileSync(join(TEMPLATES_ROOT, rel), 'utf8'));
		// No `generatedBanner` local: the typeof guard must keep EJS from
		// throwing a ReferenceError. We only assert the banner line itself does
		// not crash — full bodies need richer locals, so we render just the
		// first line in isolation.
		const firstBodyLine = body
			.split('\n')
			.find((l) => l.includes('generatedBanner'))!;
		expect(() => ejs.render(firstBodyLine, {}, { rmWhitespace: false })).not.toThrow();
		expect(ejs.render(firstBodyLine, {}, { rmWhitespace: false }).trim()).toBe('');
	});
});
