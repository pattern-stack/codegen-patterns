/**
 * Every `src/…` module a hygen template imports must be in the published
 * `files` manifest.
 *
 * The templates ship in the package and run in the consumer's project, so any
 * `src/…` module they import has to ship with them. The manifest lists those
 * modules one by one — `src/patterns/registry.ts`, `src/patterns/pattern-definition.ts`,
 * … — because the rest of `src/` is published only as compiled `dist/`.
 *
 * That list is easy to forget, and forgetting it produces the works-from-checkout,
 * broken-from-tarball failure (#266: `prompt.js` importing an unshipped `src/`
 * module). `just test-post-publish` catches it — but it is not in `just test-all`,
 * so nothing in the default CI run does. This test closes that gap by walking the
 * import graph instead of restating it (charter I1).
 */

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const TEMPLATES = path.join(REPO_ROOT, 'templates');

/** Files hygen actually executes or renders. */
const TEMPLATE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.t'];

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (TEMPLATE_EXTENSIONS.some((e) => entry.name.endsWith(e))) out.push(full);
	}
	return out;
}

/**
 * Drop comments before scanning. JSDoc carries `import('…/foo.ts')` TYPE
 * references that are erased and never loaded — counting them would demand a
 * manifest entry for a file nothing actually imports.
 */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** `import … from '<spec>'` / `await import('<spec>')` / `require('<spec>')`. */
function importSpecifiers(raw: string): string[] {
	const source = stripComments(raw);
	const specs: string[] = [];
	const patterns = [
		/\bfrom\s+['"]([^'"]+)['"]/g,
		/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
		/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
	];
	for (const re of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(source)) !== null) specs.push(m[1]!);
	}
	return specs;
}

/**
 * Resolve a relative specifier to a repo-relative path. Templates author
 * `.js` specifiers that bun resolves to the `.ts` source, so try both.
 */
function resolveRelative(fromFile: string, spec: string): string | null {
	const base = path.resolve(path.dirname(fromFile), spec);
	const candidates = [
		base,
		base.replace(/\.js$/, '.ts'),
		base.replace(/\.mjs$/, '.mts'),
		`${base}.ts`,
		path.join(base, 'index.ts'),
	];
	for (const c of candidates) {
		if (fs.existsSync(c) && fs.statSync(c).isFile()) {
			return path.relative(REPO_ROOT, c);
		}
	}
	return null;
}

/** Does one `files` manifest entry cover this repo-relative path? */
function entryCovers(entry: string, relPath: string): boolean {
	const normalized = entry.replace(/^\.\//, '');
	if (!/[*?]/.test(normalized)) {
		// npm treats a bare path as "this file, or everything under this directory".
		return relPath === normalized || relPath.startsWith(`${normalized}/`);
	}
	const re = new RegExp(
		`^${normalized
			.split('**')
			.map((part) =>
				part
					.replace(/[.+^${}()|[\]\\]/g, '\\$&')
					.replace(/\*/g, '[^/]*')
					.replace(/\?/g, '[^/]'),
			)
			.join('.*')}$`,
	);
	return re.test(relPath);
}

describe('published files manifest covers every src/ module the templates import', () => {
	const pkg = JSON.parse(
		fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
	) as { files: string[] };

	// Walk the graph: template files → their `src/…` imports → those modules'
	// own relative imports, transitively.
	const reached = new Set<string>();
	const queue: string[] = [];

	for (const file of walk(TEMPLATES)) {
		const source = fs.readFileSync(file, 'utf-8');
		for (const spec of importSpecifiers(source)) {
			if (!spec.startsWith('.')) continue;
			const resolved = resolveRelative(file, spec);
			if (resolved && resolved.startsWith('src/')) queue.push(resolved);
		}
	}

	while (queue.length > 0) {
		const rel = queue.pop()!;
		if (reached.has(rel)) continue;
		reached.add(rel);
		const abs = path.join(REPO_ROOT, rel);
		for (const spec of importSpecifiers(fs.readFileSync(abs, 'utf-8'))) {
			if (!spec.startsWith('.')) continue;
			const resolved = resolveRelative(abs, spec);
			if (resolved && resolved.startsWith('src/')) queue.push(resolved);
		}
	}

	test('the templates do import src/ modules (the walk is not vacuously empty)', () => {
		expect(reached.size).toBeGreaterThan(0);
	});

	test('every reached module is covered by a `files` entry', () => {
		const uncovered = [...reached]
			.filter((rel) => !pkg.files.some((entry) => entryCovers(entry, rel)))
			.sort();
		expect(uncovered).toEqual([]);
	});
});
