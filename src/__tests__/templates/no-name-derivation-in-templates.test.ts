/**
 * ADR-046 — templates print names; they do not derive them (PLAN §7.3).
 *
 * Scans every template-side file under `templates/` (`.ejs.t`, `.js`, `.mjs`) for the known spellings of an
 * inline name derivation. Each site still waiting to move into `src/derived/api/` is named in
 * `no-name-derivation.allowlist.ts` with its exact count; the list only shrinks.
 *
 * Comment lines are skipped so a docblock may quote a shape — but a comment line carrying an EJS tag (`<%`) is
 * emitted text built from a derivation, not a comment about one, and is scanned.
 *
 * Its limit, stated: a regex catches the known spellings only. The parity gate
 * (`src/__tests__/derived/api-surface-parity.test.ts`) catches what it misses.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { NO_NAME_DERIVATION_ALLOWLIST, type AllowlistEntry } from './no-name-derivation.allowlist';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const SCAN_ROOT = 'templates';

type PatternId = AllowlistEntry['pattern'];

const PATTERNS: Record<PatternId, { re: RegExp; ejsOnly: boolean }> = {
	'inline-camel-case': { re: /\.replace\(\/_\(\[a-z\]\)\/g/g, ejsOnly: false },
	'charat-upper-case': { re: /\.charAt\(0\)\.toUpperCase\(\)/g, ejsOnly: true },
	'string-built-finder': { re: /`findBy\$\{|findBy<%/g, ejsOnly: false },
	'local-case-helper': { re: /\b(?:const|let|var|function)\s+(?:camelCase|pascalCase)\b/g, ejsOnly: false },
};

function templateFiles(dir: string): string[] {
	return readdirSync(dir)
		.sort()
		.flatMap((name) => {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) return templateFiles(full);
			return /\.(ejs\.t|js|mjs)$/.test(name) ? [full] : [];
		});
}

/** Blank out comment-only lines — unless they carry an EJS tag, which makes them emitted text. */
export function stripCommentLines(source: string): string {
	return source
		.split('\n')
		.map((line) => {
			const t = line.trimStart();
			if (t.startsWith('<%#')) return ''; // an EJS comment: never emitted
			const comment = t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
			return comment && !line.includes('<%') ? '' : line;
		})
		.join('\n');
}

/** Every (file, pattern) with a non-zero count. */
export function scanSites(source: string, file: string): Map<PatternId, number> {
	const out = new Map<PatternId, number>();
	const text = stripCommentLines(source);
	for (const [id, { re, ejsOnly }] of Object.entries(PATTERNS) as [PatternId, (typeof PATTERNS)[PatternId]][]) {
		if (ejsOnly && !file.endsWith('.ejs.t')) continue;
		const n = text.match(re)?.length ?? 0;
		if (n > 0) out.set(id, n);
	}
	return out;
}

/** The lint's verdict: one message per site not allowlisted, and per allowlist entry whose count is off. */
export function lint(found: Map<string, Map<PatternId, number>>, allowlist: readonly AllowlistEntry[]): string[] {
	const errors: string[] = [];
	const key = (file: string, pattern: string) => `${file}\0${pattern}`;
	const allowed = new Map(allowlist.map((e) => [key(e.file, e.pattern), e]));
	for (const [file, sites] of found) {
		for (const [pattern, n] of sites) {
			if (!allowed.has(key(file, pattern))) {
				errors.push(`no-name-derivation: ${file} — ${n} ${pattern} not in the allowlist`);
			}
		}
	}
	for (const e of allowlist) {
		const m = found.get(e.file)?.get(e.pattern) ?? 0;
		if (m !== e.count) {
			errors.push(
				`no-name-derivation: allowlist entry ${e.file} · ${e.pattern} expects ${e.count}, found ${m} — shrink or delete the entry`,
			);
		}
	}
	return errors;
}

describe('no name derivation in templates (ADR-046)', () => {
	const files = templateFiles(join(REPO_ROOT, SCAN_ROOT));
	const found = new Map<string, Map<PatternId, number>>();
	for (const full of files) {
		const rel = relative(REPO_ROOT, full).split('\\').join('/');
		const sites = scanSites(readFileSync(full, 'utf-8'), rel);
		if (sites.size > 0) found.set(rel, sites);
	}

	it('scans the template tree (guards against an empty sweep)', () => {
		expect(files.length).toBeGreaterThan(50);
		expect(files.some((f) => f.endsWith('entity/new/backend/service.ejs.t'))).toBe(true);
	});

	it('every inline name derivation is allowlisted, with its exact count', () => {
		expect(lint(found, NO_NAME_DERIVATION_ALLOWLIST)).toEqual([]);
	});

	it('every allowlist entry names its issue, once', () => {
		const keys = NO_NAME_DERIVATION_ALLOWLIST.map((e) => `${e.file} · ${e.pattern}`);
		expect(new Set(keys).size).toBe(keys.length);
		for (const e of NO_NAME_DERIVATION_ALLOWLIST) {
			expect(e.issue.length).toBeGreaterThan(0);
			expect(e.count).toBeGreaterThan(0);
		}
	});
});

describe('no-name-derivation lint — the rule itself', () => {
	it('counts each spelling, skips a plain comment, and scans a comment that carries an EJS tag', () => {
		const src = [
			"const a = s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());",
			'// s.replace(/_([a-z])/g — explained, not done',
			'// <%= name.charAt(0).toUpperCase() %> Events',
			'async findBy<%= fk %>() {}',
			'const n = `findBy${x}`;',
			'function pascalCase(s) {}',
		].join('\n');
		expect(Object.fromEntries(scanSites(src, 'x.ejs.t'))).toEqual({
			'inline-camel-case': 1,
			'charat-upper-case': 1,
			'string-built-finder': 2,
			'local-case-helper': 1,
		});
		expect(scanSites(src, 'x.js').has('charat-upper-case')).toBe(false);
	});

	it('reports a new site and a stale entry with their exact messages', () => {
		const found = new Map([['t/a.ejs.t', new Map<PatternId, number>([['inline-camel-case', 1]])]]);
		const allowlist: AllowlistEntry[] = [{ file: 't/b.ejs.t', pattern: 'inline-camel-case', count: 4, issue: 'x' }];
		expect(lint(found, allowlist)).toEqual([
			'no-name-derivation: t/a.ejs.t — 1 inline-camel-case not in the allowlist',
			'no-name-derivation: allowlist entry t/b.ejs.t · inline-camel-case expects 4, found 0 — shrink or delete the entry',
		]);
	});
});
