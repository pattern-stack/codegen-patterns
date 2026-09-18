/**
 * `checkGitSafety` — the generator commands' uncommitted-changes gate. `entity
 * new`, `junction new` and `relationship new` pass the three generated-output
 * roots from `projectLayout`: `backendSrc`, `modules` (PATH-1: it may lie
 * outside `backend_src`) and `generated`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkGitSafety } from '../../cli/shared/git-safety';
import { projectLayout } from '../../cli/shared/project-layout';

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function repo(files: string[]): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-safety-'));
	tmpDirs.push(dir);
	const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: 'ignore' });
	git('init -q');
	git('config user.email t@t');
	git('config user.name t');
	for (const f of files) {
		fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
		fs.writeFileSync(path.join(dir, f), 'v1\n');
	}
	git('add -A');
	git('commit -q -m init');
	return dir;
}

const edit = (dir: string, f: string) => fs.writeFileSync(path.join(dir, f), 'v2\n');

describe('checkGitSafety — the three generated-output roots', () => {
	const config = { paths: { backend_src: 'apps/api/src', modules_dir: 'apps/api/domain', generated: 'apps/api/codegen' } };
	const FILES = ['apps/api/src/app.module.ts', 'apps/api/domain/crews/crew.service.ts', 'apps/api/codegen/modules.ts', 'README.md'];
	const roots = (dir: string) => {
		const layout = projectLayout(dir, config);
		return [layout.backendSrc, layout.modules, layout.generated];
	};

	it('a clean tree is clean', () => {
		const dir = repo(FILES);
		expect(checkGitSafety(roots(dir), dir)).toEqual({ clean: true, dirty: [], inRepo: true });
	});

	it('reports an edit under each root, including a modules_dir outside backend_src', () => {
		const dir = repo(FILES);
		for (const f of FILES.slice(0, 3)) edit(dir, f);
		const result = checkGitSafety(roots(dir), dir);
		expect(result.clean).toBe(false);
		expect(result.dirty.sort()).toEqual(FILES.slice(0, 3).sort());
	});

	it('ignores edits outside the three roots', () => {
		const dir = repo(FILES);
		edit(dir, 'README.md');
		expect(checkGitSafety(roots(dir), dir).clean).toBe(true);
	});

	it('the default layout nests modules_dir in backend_src: an edit there is reported once', () => {
		const dir = repo(['src/modules/crews/crew.service.ts', 'src/generated/modules.ts']);
		edit(dir, 'src/modules/crews/crew.service.ts');
		const layout = projectLayout(dir, null);
		const result = checkGitSafety([layout.backendSrc, layout.modules, layout.generated], dir);
		expect(result.dirty).toEqual(['src/modules/crews/crew.service.ts']);
	});

	it('a root that does not exist yet is fine (first generation)', () => {
		const dir = repo(['apps/api/src/app.module.ts']);
		expect(checkGitSafety(roots(dir), dir)).toEqual({ clean: true, dirty: [], inRepo: true });
	});
});
