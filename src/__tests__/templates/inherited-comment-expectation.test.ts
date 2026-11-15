/**
 * Named expectation — the one place each backend template still reads a pattern's inherited-methods list (#893).
 *
 * ADR-046 Phase B moved every generated name into `src/derived/api/`. The `// Inherited from <Base>:` comment could
 * not move with them: it prints the pattern's declared lines verbatim, and the derived surface's `inherited` entries
 * are split into single names and leave out the methods the class also emits, so printing from them would change the
 * comment's bytes in every generated class while Phase B was byte-identical by rule.
 *
 * Each entry below pins that reference to exactly one occurrence, and that occurrence to the comment block: the line
 * right after `// Inherited from …:`, which prints the pattern's lines as `//   <line>`. It fails if the reference
 * spreads to a second place, moves off the comment, or disappears — and when #893 prints the comment from the
 * derivation, it fails until this entry is deleted.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

interface InheritedCommentExpectation {
	/** Repo-relative template. */
	file: string;
	/** The locals key the comment still reads. */
	local: string;
	/** What removes it. */
	issue: string;
}

const INHERITED_COMMENT_EXPECTATIONS: readonly InheritedCommentExpectation[] = [
	{ file: 'templates/entity/new/backend/repository.ejs.t', local: 'repositoryInheritedMethods', issue: '#893' },
];

describe('named expectation — the inherited-methods comment is the only reader of the pattern list (#893)', () => {
	for (const { file, local, issue } of INHERITED_COMMENT_EXPECTATIONS) {
		test(`${file} reads \`${local}\` exactly once, on the inherited comment (${issue})`, () => {
			const lines = readFileSync(join(REPO_ROOT, file), 'utf-8').split('\n');
			const word = new RegExp(`\\b${local}\\b`);
			const hits = lines.flatMap((line, i) => (word.test(line) ? [i] : []));
			expect(hits.length).toBe(1);

			const at = hits[0]!;
			// The comment heading, then (optionally) one EJS block comment, which emits nothing, then the loop.
			const heading = lines.findLastIndex((line, i) => i < at && /^\s*\/\/ Inherited from <%= \w+ %>:$/.test(line));
			expect(heading).toBeGreaterThanOrEqual(0);
			expect(lines.slice(heading + 1, at).join('\n')).toMatch(/^(<%_ \/\*[^]*?\*\/ _%>)?$/);
			expect(lines[at]).toMatch(new RegExp(`^<%_ ${local}\\.forEach\\(line => \\{ _%>$`));
			expect(lines[at + 1]).toMatch(/^\s*\/\/ {3}<%= line %>$/);
		});
	}
});
