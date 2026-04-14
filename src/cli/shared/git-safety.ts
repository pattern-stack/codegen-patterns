/**
 * Git safety check — warn before overwriting files with uncommitted changes.
 *
 * Used by `entity new` and `subsystem install` to prevent silent clobbering.
 * Non-git projects return { clean: true, dirty: [] }.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';

export interface GitSafetyResult {
	clean: boolean;
	dirty: string[];
	inRepo: boolean;
}

function isInsideGitRepo(cwd: string): boolean {
	try {
		execSync('git rev-parse --is-inside-work-tree', {
			cwd,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Run `git status --porcelain` against the given paths. Returns the subset
 * of paths that have modifications. An empty `paths` array returns a clean
 * result.
 */
export function checkGitSafety(paths: string[], cwd: string = process.cwd()): GitSafetyResult {
	if (paths.length === 0) return { clean: true, dirty: [], inRepo: isInsideGitRepo(cwd) };

	if (!isInsideGitRepo(cwd)) {
		return { clean: true, dirty: [], inRepo: false };
	}

	// Normalize paths to relative POSIX paths — git status prefers them.
	const rels = paths.map((p) => {
		const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
		return path.relative(cwd, abs).replace(/\\/g, '/');
	});

	// Build safe argument list; execFile-style via execSync with `--` separator.
	const argStr = rels.map((r) => `"${r.replace(/"/g, '\\"')}"`).join(' ');
	let output = '';
	try {
		output = execSync(`git status --porcelain -- ${argStr}`, {
			cwd,
			stdio: ['ignore', 'pipe', 'ignore'],
		}).toString();
	} catch {
		return { clean: true, dirty: [], inRepo: true };
	}

	const dirty: string[] = [];
	for (const line of output.split('\n')) {
		if (!line.trim()) continue;
		// porcelain lines: "XY path" (X+Y = 2 status chars, then space, then path)
		const match = line.match(/^..\s(.+)$/);
		if (match) dirty.push(match[1].trim());
	}

	return { clean: dirty.length === 0, dirty, inRepo: true };
}
