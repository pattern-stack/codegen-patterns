/**
 * tree-copier — recursively copy a source directory into a target with
 * drift-aware classification.
 *
 * Used by the `skills` noun (vendoring `consumer-skills/*` into a consumer's
 * `.claude/skills/`) and by `codegen update` (re-syncing package-owned files).
 *
 * Each file is classified per its on-disk state in the target:
 *   - created   — target did not exist; written
 *   - updated   — target existed with different content; overwritten
 *   - unchanged — target existed with identical content; left as-is
 *
 * Divergent files are overwritten because the callers (`skills install`,
 * `codegen update`) re-sync package-owned managed files to the installed
 * package version — the cross-version delta *is* a content diff, so skipping
 * divergent files would make the sync a no-op. The safety net lives one layer
 * up: the command checks git-cleanliness before writing (and `--dry-run`
 * previews the full report without touching disk).
 */

import fs from 'node:fs';
import path from 'node:path';

export type TreeCopyAction = 'created' | 'updated' | 'unchanged';

export interface TreeCopyEntry {
	/** Path relative to `srcDir` (POSIX-style, for display). */
	relPath: string;
	/** Absolute destination path. */
	dest: string;
	action: TreeCopyAction;
}

export interface TreeCopyReport {
	entries: TreeCopyEntry[];
	created: TreeCopyEntry[];
	updated: TreeCopyEntry[];
	unchanged: TreeCopyEntry[];
}

export interface TreeCopyOptions {
	srcDir: string;
	destDir: string;
	/** Classify only — write nothing. Default false. */
	dryRun?: boolean;
	/**
	 * Optional content rewrite applied to text files on copy. Receives the raw
	 * source content + the absolute destination path; returns the content to
	 * write. Only invoked for `.ts`/`.tsx`/`.md` files.
	 */
	transform?: (content: string, destPath: string) => string;
	/**
	 * Optional filter on the relative path (POSIX). Return false to exclude a
	 * file from the copy entirely. Default: include all files.
	 */
	include?: (relPath: string) => boolean;
}

const TEXT_EXTENSIONS = ['.ts', '.tsx', '.md', '.mdx', '.yaml', '.yml', '.json'];

function isTextFile(name: string): boolean {
	return TEXT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Recursively copy `srcDir` → `destDir` with drift classification. Returns a
 * structured report; honours `force`, `dryRun`, `transform`, and `include`.
 */
export function copyTreeWithReport(opts: TreeCopyOptions): TreeCopyReport {
	const { srcDir, destDir, dryRun = false, transform, include } = opts;

	const report: TreeCopyReport = {
		entries: [],
		created: [],
		updated: [],
		unchanged: [],
	};

	if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
		throw new Error(`tree-copier source directory not found: ${srcDir}`);
	}

	const walk = (relDir: string): void => {
		const absSrcDir = path.join(srcDir, relDir);
		for (const entry of fs.readdirSync(absSrcDir, { withFileTypes: true })) {
			const relPath = relDir ? path.posix.join(relDir, entry.name) : entry.name;
			const absSrc = path.join(srcDir, relPath);
			if (entry.isDirectory()) {
				walk(relPath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (include && !include(relPath)) continue;

			const dest = path.join(destDir, relPath);
			let content = fs.readFileSync(absSrc, 'utf-8');
			if (transform && isTextFile(entry.name)) {
				content = transform(content, dest);
			}

			const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf-8') : null;

			let action: TreeCopyAction;
			if (existing === null) {
				action = 'created';
			} else if (existing === content) {
				action = 'unchanged';
			} else {
				action = 'updated';
			}

			if (!dryRun && action !== 'unchanged') {
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.writeFileSync(dest, content, 'utf-8');
			}

			const record: TreeCopyEntry = { relPath, dest, action };
			report.entries.push(record);
			report[action].push(record);
		}
	};

	walk('');
	return report;
}
