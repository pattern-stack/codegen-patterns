/**
 * emitJobHandlers write-orchestration tests (RFC-0005, breakdown #7b).
 *
 * Verifies the file layout + the seam-split write semantics: the @generated base
 * reflows on every run (byte-idempotent), and the emit-once subclass is written
 * once then skipped (author edits survive regen).
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as read } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { JobDefinitionSchema, type JobDefinition } from '../../schema/job-definition.schema';
import { emitJobHandlers } from '../../cli/shared/emit-jobs';

const FIXTURE_DIR = resolve(__dirname, '../../../test/fixtures/jobs');
const loadJob = (name: string): JobDefinition =>
	JobDefinitionSchema.parse(parseYaml(read(resolve(FIXTURE_DIR, name), 'utf8')));

const drivePoll = loadJob('drive_poll.yaml');
const reconcilePoll = loadJob('reconcile_poll.yaml');

const tmpDirs: string[] = [];
function tmpJobsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'emit-jobs-'));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	while (tmpDirs.length) {
		const d = tmpDirs.pop();
		if (d) rmSync(d, { recursive: true, force: true });
	}
});

describe('emitJobHandlers', () => {
	it('writes a @generated base + an emit-once subclass per job', () => {
		const dir = tmpJobsDir();
		const res = emitJobHandlers({ jobs: [drivePoll, reconcilePoll], jobsHandlersDir: dir });
		expect(res.basesWritten).toHaveLength(2);
		expect(res.scaffoldsWritten).toHaveLength(2);
		expect(res.scaffoldsSkipped).toEqual([]);
		expect(existsSync(join(dir, 'drive_poll.job.generated.ts'))).toBe(true);
		expect(existsSync(join(dir, 'drive_poll.job.ts'))).toBe(true);
		expect(readFileSync(join(dir, 'drive_poll.job.generated.ts'), 'utf8')).toContain('@generated');
	});

	it('reflows the base but PRESERVES author edits to the subclass on re-emit', () => {
		const dir = tmpJobsDir();
		emitJobHandlers({ jobs: [drivePoll], jobsHandlersDir: dir });
		const subPath = join(dir, 'drive_poll.job.ts');
		// Simulate an author edit to the emit-once subclass.
		writeFileSync(subPath, '// AUTHOR EDIT — do not clobber\n', 'utf8');

		const res2 = emitJobHandlers({ jobs: [drivePoll], jobsHandlersDir: dir });
		// The subclass is skipped (author edit survives); the base reflows.
		expect(res2.scaffoldsSkipped).toEqual([subPath]);
		expect(res2.scaffoldsWritten).toEqual([]);
		expect(readFileSync(subPath, 'utf8')).toBe('// AUTHOR EDIT — do not clobber\n');
		expect(readFileSync(join(dir, 'drive_poll.job.generated.ts'), 'utf8')).toContain('DrivePollJobBase');
	});

	it('dryRun computes paths without writing', () => {
		const dir = tmpJobsDir();
		const res = emitJobHandlers({ jobs: [drivePoll], jobsHandlersDir: dir, dryRun: true });
		expect(res.basesWritten).toHaveLength(1);
		expect(existsSync(join(dir, 'drive_poll.job.generated.ts'))).toBe(false);
	});
});
