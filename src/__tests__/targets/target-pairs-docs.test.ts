/**
 * TGT-0 (ADR-047): `TARGET_PAIRS` (`src/targets/pairs.ts`) is the only list of supported `(database, orm)` pairs.
 * The docs that name the pairs for a reader say "Supported pairs:" and list them in backticks; this holds each such
 * list to the table, so adding a pair without its docs, or a docs pair without a renderer, fails here.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { supportedTargetPairs } from '../../targets/pairs';

const REPO = path.resolve(import.meta.dir, '../../..');
const DOCS = ['README.md', 'docs/CONSUMER-SETUP.md', '.claude/skills/codegen/SKILL.md'];

/** The backticked pairs in the sentence after "Supported pairs:" (up to the next sentence end or table cell). */
function listedPairs(text: string): string[][] {
	const lists: string[][] = [];
	for (const m of text.matchAll(/Supported pairs:([^|.]*(?:\.[^\s|][^|.]*)*)/g)) {
		lists.push([...m[1]!.matchAll(/`(\{ database: [a-z0-9-]+, orm: [a-z0-9-]+ \})`/g)].map((p) => p[1]!));
	}
	return lists;
}

describe('the docs list exactly the supported target pairs', () => {
	it.each(DOCS)('%s', (doc) => {
		const lists = listedPairs(fs.readFileSync(path.join(REPO, doc), 'utf-8'));
		expect(lists.length).toBeGreaterThan(0);
		for (const pairs of lists) expect(pairs.sort()).toEqual([...supportedTargetPairs()].sort());
	});
});
