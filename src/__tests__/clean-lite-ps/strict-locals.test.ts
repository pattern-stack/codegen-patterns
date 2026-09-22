/**
 * #638: every clean-lite-ps local is referenced unguarded, so a missing one
 * throws instead of emitting nothing. clean-lite-ps is the only backend
 * pipeline (ARCH-0, #677), so hygen never renders these bodies without the
 * clean-lite-ps locals and no template carries a `typeof` guard — not even the
 * one `typeof clpOutputPaths` body guard the `clean` pipeline used to need.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ejs from 'ejs';
import {
	assertNoUndefinedLocals,
	buildCleanLitePsLocals,
} from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';
import { withEntities } from './_entity-lookup';

const CLP_ROOT = resolve(import.meta.dir, '../../../templates/entity/new/clean-lite-ps');

function walk(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, acc);
		else if (entry.name.endsWith('.ejs.t')) acc.push(full);
	}
	return acc;
}

const TEMPLATES = walk(CLP_ROOT)
	.map((abs) => relative(CLP_ROOT, abs))
	.sort();

function body(rel: string): string {
	const source = readFileSync(join(CLP_ROOT, rel), 'utf8');
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
	return buildCleanLitePsLocals(definition, withEntities()) as Record<string, unknown>;
}

describe('clean-lite-ps bodies', () => {
	it('enumerates the templates', () => {
		expect(TEMPLATES.length).toBeGreaterThan(15);
	});

	it.each(TEMPLATES)('%s throws with no clean-lite-ps locals', (rel) => {
		expect(() => render(rel, {})).toThrow(/is not defined/);
	});
});

describe('clean-lite-ps bodies under clean-lite-ps', () => {
	it.each(TEMPLATES)('%s renders with the full local set', (rel) => {
		expect(() => render(rel, locals())).not.toThrow();
	});

	it('a missing clean-lite-ps local throws instead of emitting nothing', () => {
		const l = locals();
		expect(render('entity.ejs.t', l)).toContain('AnyPgColumn');
		delete l.clpHasFk;
		expect(() => render('entity.ejs.t', l)).toThrow(/clpHasFk is not defined/);
	});

	it('a missing prompt-owned local throws instead of falling back', () => {
		const l = locals();
		delete l.drizzleTokenImport;
		expect(() => render('repository.ejs.t', l)).toThrow(/drizzleTokenImport is not defined/);
	});

	it('a clean-lite-ps local set to undefined is rejected by name', () => {
		expect(() => assertNoUndefinedLocals({ clpHasFk: undefined, clpBelongsTo: [] }, 'note')).toThrow(
			/clean-lite-ps locals for 'note' are undefined: clpHasFk/,
		);
		expect(() => assertNoUndefinedLocals({ composedBaseClass: null }, 'note')).not.toThrow();
	});

});

describe('no typeof guards remain (#638, ARCH-0)', () => {
	it.each(TEMPLATES)('%s', (rel) => {
		const source = readFileSync(join(CLP_ROOT, rel), 'utf8');
		expect(source).not.toMatch(/typeof\s+\w+\s*[!=]==\s*'undefined'/);
	});
});
