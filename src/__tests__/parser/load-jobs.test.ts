/**
 * loadJobs() unit tests (RFC-0005, breakdown #6).
 *
 * Happy path runs against the real RFC-0005 §3 fixtures; error cases use
 * throwaway temp dirs so the fixtures dir stays clean. Mirrors the loadEvents
 * loader contract: never throws, accumulates AnalysisIssues, enforces
 * filename↔type and duplicate-type.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { loadJobs } from '../../parser/load-jobs';

const FIXTURE_DIR = resolve(__dirname, '../../../test/fixtures/jobs');

const VALID_POLL_JOB = (type: string) => `
type: ${type}
pool: integration
arms:
  - kind: poll
    domain: document
    read:
      mode: poll
      poll:
        cursor: { kind: timestamp, field: updated_at }
      mapping:
        - { source: id, target: external_id }
`;

const tmpDirs: string[] = [];
function makeJobsDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'jobs-loader-'));
	tmpDirs.push(dir);
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content, 'utf8');
	}
	return dir;
}

afterEach(() => {
	while (tmpDirs.length) {
		const dir = tmpDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

// ----------------------------------------------------------------------------
// Happy path — the three §3 fixtures
// ----------------------------------------------------------------------------

describe('loadJobs — RFC-0005 §3 fixtures', () => {
	it('loads all three fixtures with zero error issues', () => {
		const { jobs, issues } = loadJobs(FIXTURE_DIR);
		expect(jobs.map((j) => j.type).sort()).toEqual([
			'drive_poll',
			'inbound_sync',
			'reconcile_poll',
		]);
		expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
	});
});

// ----------------------------------------------------------------------------
// Directory edge cases — opt-in, never throws
// ----------------------------------------------------------------------------

describe('loadJobs — directory edge cases', () => {
	it('warns (does not throw) on a nonexistent directory', () => {
		const { jobs, issues } = loadJobs('/no/such/jobs/dir');
		expect(jobs).toEqual([]);
		expect(issues.some((i) => i.severity === 'warning' && i.type === 'no_jobs_dir')).toBe(true);
	});

	it('warns on an empty directory', () => {
		const dir = makeJobsDir({});
		const { jobs, issues } = loadJobs(dir);
		expect(jobs).toEqual([]);
		expect(issues.some((i) => i.severity === 'warning' && i.type === 'no_files')).toBe(true);
	});
});

// ----------------------------------------------------------------------------
// Per-file errors — accumulate, no short-circuit
// ----------------------------------------------------------------------------

describe('loadJobs — per-file errors', () => {
	it('errors on a filename ↔ type mismatch', () => {
		const dir = makeJobsDir({ 'drive_poll.yaml': VALID_POLL_JOB('something_else') });
		const { jobs, issues } = loadJobs(dir);
		expect(jobs).toEqual([]);
		expect(issues.some((i) => i.type === 'job_filename_mismatch')).toBe(true);
	});

	it('errors on a duplicate job type (.yaml + .yml twins)', () => {
		const dir = makeJobsDir({
			'drive_poll.yaml': VALID_POLL_JOB('drive_poll'),
			'drive_poll.yml': VALID_POLL_JOB('drive_poll'),
		});
		const { issues } = loadJobs(dir);
		expect(issues.some((i) => i.type === 'duplicate_job_type')).toBe(true);
	});

	it('surfaces schema validation errors (bad arm kind) as error issues', () => {
		const dir = makeJobsDir({
			'broken.yaml': `
type: broken
arms:
  - kind: streaming
    domain: document
`,
		});
		const { jobs, issues } = loadJobs(dir);
		expect(jobs).toEqual([]);
		expect(issues.some((i) => i.severity === 'error' && i.type === 'schema_error')).toBe(true);
	});

	it('does not short-circuit — a good file still loads alongside a bad one', () => {
		const dir = makeJobsDir({
			'drive_poll.yaml': VALID_POLL_JOB('drive_poll'),
			'broken.yaml': 'type: broken\narms: []\n',
		});
		const { jobs, issues } = loadJobs(dir);
		expect(jobs.map((j) => j.type)).toEqual(['drive_poll']);
		expect(issues.some((i) => i.severity === 'error')).toBe(true);
	});
});
