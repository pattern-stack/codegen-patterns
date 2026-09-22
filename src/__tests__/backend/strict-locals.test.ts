/**
 * #638: every backend local is referenced unguarded, so a missing one
 * throws instead of emitting nothing. backend is the only backend
 * pipeline (ARCH-0, #677), so hygen never renders these bodies without the
 * backend locals and no template carries a `typeof` guard — not even the
 * one `typeof outputPaths` body guard the `clean` pipeline used to need.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ejs from 'ejs';
import {
	assertNoUndefinedLocals,
	buildBackendLocals,
} from '../../../templates/entity/new/backend/entity-locals.js';
import { withEntities } from './_entity-lookup';

const BACKEND_ROOT = resolve(import.meta.dir, '../../../templates/entity/new/backend');

function walk(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, acc);
		else if (entry.name.endsWith('.ejs.t')) acc.push(full);
	}
	return acc;
}

const TEMPLATES = walk(BACKEND_ROOT)
	.map((abs) => relative(BACKEND_ROOT, abs))
	.sort();

function body(rel: string): string {
	const source = readFileSync(join(BACKEND_ROOT, rel), 'utf8');
	const end = source.indexOf('\n---\n', 4);
	return source.slice(end + 5);
}

function render(rel: string, locals: Record<string, unknown>): string {
	return ejs.render(body(rel), locals, { rmWhitespace: false });
}

const definition = {
	entity: { name: 'note', plural: 'notes', table: 'notes' },
	fields: { title: { type: 'string', required: true } },
	relationships: { account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } },
	behaviors: ['timestamps'],
};

function locals(): Record<string, unknown> {
	return buildBackendLocals(definition, withEntities()) as Record<string, unknown>;
}

describe('backend bodies', () => {
	it('enumerates the templates', () => {
		expect(TEMPLATES.length).toBeGreaterThan(15);
	});

	it.each(TEMPLATES)('%s throws with no backend locals', (rel) => {
		expect(() => render(rel, {})).toThrow(/is not defined/);
	});
});

describe('backend bodies under backend', () => {
	it.each(TEMPLATES)('%s renders with the full local set', (rel) => {
		expect(() => render(rel, locals())).not.toThrow();
	});

	it('a missing backend local throws instead of emitting nothing', () => {
		const l = locals();
		expect(render('entity.ejs.t', l)).toContain('AnyPgColumn');
		delete l.hasFk;
		expect(() => render('entity.ejs.t', l)).toThrow(/hasFk is not defined/);
	});

	it('a missing prompt-owned local throws instead of falling back', () => {
		const l = locals();
		delete l.drizzleTokenImport;
		expect(() => render('repository.ejs.t', l)).toThrow(/drizzleTokenImport is not defined/);
	});

	it('a backend local set to undefined is rejected by name', () => {
		expect(() => assertNoUndefinedLocals({ hasFk: undefined, belongsTo: [] }, 'note')).toThrow(
			/backend locals for 'note' are undefined: hasFk/,
		);
		expect(() => assertNoUndefinedLocals({ composedBaseClass: null }, 'note')).not.toThrow();
	});

});

describe('no typeof guards remain (#638, ARCH-0)', () => {
	it.each(TEMPLATES)('%s', (rel) => {
		const source = readFileSync(join(BACKEND_ROOT, rel), 'utf8');
		expect(source).not.toMatch(/typeof\s+\w+\s*[!=]==\s*'undefined'/);
	});
});
