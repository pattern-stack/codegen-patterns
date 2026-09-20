/**
 * `GET /api/diff` (STUDIO-0, #698).
 *
 * The demo project is a real git repository, so the diff Studio shows after a
 * run is a real `git diff` in it — no synthesized before/after from the
 * generator's own bookkeeping.
 *
 * Two things `git` will not do for you here:
 *   - `--porcelain` collapses an untracked DIRECTORY to one entry, which is
 *     exactly the case that matters (a newly generated module folder). `-uall`
 *     lists its files instead.
 *   - `git diff` emits nothing at all for an untracked file, so each one goes
 *     through `git diff --no-index /dev/null <file>` to get an all-added patch.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import type { DiffFile, DiffResponse, DiffStatus } from '../shared/api.js';

function git(projectDir: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const res = spawnSync('git', args, {
		cwd: projectDir,
		encoding: 'utf-8',
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, GIT_PAGER: 'cat', GIT_CONFIG_NOSYSTEM: '1' },
	});
	return {
		// `git diff --no-index` exits 1 when files differ — that is success here,
		// so callers that care about content check stdout, not the code.
		ok: res.status === 0,
		stdout: res.stdout ?? '',
		stderr: res.stderr ?? '',
	};
}

export function isGitRepo(projectDir: string): boolean {
	return git(projectDir, ['rev-parse', '--is-inside-work-tree']).ok;
}

/** Map a `git status --porcelain` XY code to the wire status. */
export function statusFromPorcelain(code: string): DiffStatus {
	if (code.includes('?')) return 'untracked';
	if (code.includes('R')) return 'renamed';
	if (code.includes('D')) return 'deleted';
	if (code.includes('A')) return 'added';
	return 'modified';
}

/**
 * Parse `git status --porcelain -uall -z` output into (code, path) pairs.
 *
 * NUL-separated so a path with a space or a quote needs no unquoting. A rename
 * entry is two NUL-terminated records (new path, then old path); the old path
 * is consumed and dropped.
 */
export function parsePorcelainZ(out: string): Array<{ code: string; file: string }> {
	const records = out.split('\0').filter((r) => r.length > 0);
	const entries: Array<{ code: string; file: string }> = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		const code = record.slice(0, 2);
		const file = record.slice(3);
		if (code.includes('R') || code.includes('C')) i++; // skip the source path
		entries.push({ code, file });
	}
	return entries;
}

/** A unified patch presenting `file` as entirely new. */
function untrackedPatch(projectDir: string, file: string): string {
	const res = git(projectDir, [
		'diff',
		'--no-index',
		'--no-color',
		'--',
		'/dev/null',
		path.join(projectDir, file),
	]);
	// --no-index exits 1 on a difference, which is the expected case.
	return res.stdout;
}

export function getDiff(projectDir: string): DiffResponse {
	if (!isGitRepo(projectDir)) {
		return { files: [] };
	}

	const status = git(projectDir, ['status', '--porcelain', '-uall', '-z']);
	const files: DiffFile[] = [];

	for (const { code, file } of parsePorcelainZ(status.stdout)) {
		const st = statusFromPorcelain(code);
		const patch =
			st === 'untracked'
				? untrackedPatch(projectDir, file)
				: git(projectDir, ['diff', 'HEAD', '--no-color', '--', file]).stdout;
		files.push({ path: file, status: st, patch });
	}

	return { files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
