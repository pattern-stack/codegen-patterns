/**
 * Per-checkout harness identity — unit tests.
 *
 * Several agents run gates concurrently in sibling worktrees on one machine.
 * Anything named with a fixed global string is shared between them, and one
 * run destroys another's state: the Compose project was `scaffold` in every
 * checkout, so `docker compose down -v` tore down whichever container it
 * found. These tests pin the two properties that make that impossible —
 * different checkouts get different names, and the same checkout always gets
 * the same one (otherwise teardown could not find what setup created).
 */

import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
	PORT_BASE,
	PORT_SLOTS,
	checkoutId,
	composeProjectName,
	scaffoldDatabaseUrl,
	scaffoldEnv,
	scaffoldPgPort,
} from '../../../test/scaffold/harness-env';

/** A bare env, so a value inherited from the outer shell cannot mask a bug. */
const EMPTY: NodeJS.ProcessEnv = {};

describe('checkoutId', () => {
	it('is stable for the same path', () => {
		expect(checkoutId('/root/codegen-patterns/worktrees/590')).toBe(
			checkoutId('/root/codegen-patterns/worktrees/590'),
		);
	});

	it('differs between sibling worktrees', () => {
		const ids = [
			'/root/codegen-patterns/worktrees/583',
			'/root/codegen-patterns/worktrees/586',
			'/root/codegen-patterns/worktrees/590',
			'/root/codegen-patterns/main',
		].map((p) => checkoutId(p));
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('is short and safe for a Compose project name and a directory name', () => {
		expect(checkoutId('/some/path')).toMatch(/^[0-9a-f]{8}$/);
	});

	it('does not throw on a path that does not exist', () => {
		expect(() => checkoutId('/nonexistent/checkout')).not.toThrow();
	});
});

describe('composeProjectName', () => {
	it('derives a per-checkout name with no env var set', () => {
		expect(composeProjectName(EMPTY)).toBe(`codegen-scaffold-${checkoutId()}`);
	});

	it('honours an explicit SCAFFOLD_COMPOSE_PROJECT', () => {
		expect(composeProjectName({ SCAFFOLD_COMPOSE_PROJECT: 'pinned' })).toBe('pinned');
	});

	it('ignores an ambient COMPOSE_PROJECT_NAME', () => {
		// A shell that exports it for another stack must not aim this
		// harness's `down -v` at that stack.
		expect(composeProjectName({ COMPOSE_PROJECT_NAME: 'someone-elses-stack' })).toBe(
			composeProjectName(EMPTY),
		);
	});
});

describe('scaffoldPgPort', () => {
	it('lands below the Linux ephemeral range and above the common Postgres ports', () => {
		const port = scaffoldPgPort(EMPTY);
		expect(port).toBeGreaterThanOrEqual(PORT_BASE);
		expect(port).toBeLessThan(PORT_BASE + PORT_SLOTS);
		expect(PORT_BASE).toBeGreaterThan(5432);
		// 32768 is the low end of the default ip_local_port_range; a published
		// port inside it can be stolen by a transient outbound socket.
		expect(PORT_BASE + PORT_SLOTS).toBeLessThanOrEqual(32768);
	});

	it('the window is wide enough that a dozen worktrees rarely collide', () => {
		// Birthday bound: P(any collision among n) ≈ n(n-1)/2 / slots.
		const n = 12;
		expect((n * (n - 1)) / 2 / PORT_SLOTS).toBeLessThan(0.01);
	});

	it('is stable across calls', () => {
		expect(scaffoldPgPort(EMPTY)).toBe(scaffoldPgPort(EMPTY));
	});

	it('honours an explicit SCAFFOLD_PG_PORT', () => {
		expect(scaffoldPgPort({ SCAFFOLD_PG_PORT: '5432' })).toBe(5432);
	});

	it('rejects a SCAFFOLD_PG_PORT that is not a port', () => {
		expect(() => scaffoldPgPort({ SCAFFOLD_PG_PORT: 'postgres' })).toThrow(
			/must be a port number/,
		);
		expect(() => scaffoldPgPort({ SCAFFOLD_PG_PORT: '99999' })).toThrow();
	});
});

describe('scaffoldDatabaseUrl', () => {
	it('points at the derived port, not a fixed 5432', () => {
		expect(scaffoldDatabaseUrl(EMPTY)).toBe(
			`postgresql://postgres:postgres@localhost:${scaffoldPgPort(EMPTY)}/scaffold_test`,
		);
	});

	it('honours an explicit SCAFFOLD_DATABASE_URL', () => {
		const url = 'postgresql://u:p@db.example:6000/other';
		expect(scaffoldDatabaseUrl({ SCAFFOLD_DATABASE_URL: url })).toBe(url);
	});

	it('ignores an ambient DATABASE_URL', () => {
		// Otherwise a dev shell's DATABASE_URL (typically :5432) wins while the
		// container publishes the derived port, and the suite truncates the
		// dev database.
		expect(
			scaffoldDatabaseUrl({ DATABASE_URL: 'postgresql://dev:dev@localhost:5432/app_dev' }),
		).toBe(scaffoldDatabaseUrl(EMPTY));
	});
});

describe('scaffoldEnv', () => {
	it('carries every name a scaffold subprocess needs', () => {
		expect(Object.keys(scaffoldEnv(EMPTY)).sort()).toEqual([
			'SCAFFOLD_COMPOSE_PROJECT',
			'SCAFFOLD_DATABASE_URL',
			'SCAFFOLD_PG_PORT',
		]);
	});

	it('agrees with the individual accessors', () => {
		const env = scaffoldEnv(EMPTY);
		expect(env.SCAFFOLD_COMPOSE_PROJECT).toBe(composeProjectName(EMPTY));
		expect(env.SCAFFOLD_PG_PORT).toBe(String(scaffoldPgPort(EMPTY)));
		expect(env.SCAFFOLD_DATABASE_URL).toBe(scaffoldDatabaseUrl(EMPTY));
	});

	it('the URL port and the published port are the same number', () => {
		// The compose file publishes SCAFFOLD_PG_PORT; every client reads
		// SCAFFOLD_DATABASE_URL. If these ever disagree the suite connects to nothing.
		const env = scaffoldEnv(EMPTY);
		expect(new URL(env.SCAFFOLD_DATABASE_URL!).port).toBe(env.SCAFFOLD_PG_PORT);
	});
});

/**
 * The justfile's db-* recipes `eval` this CLI's output. They fail closed only
 * if an invalid override makes the CLI exit non-zero with nothing on stdout —
 * an exit 0 with partial output would let `docker compose -p ""` fall back to
 * the shared `scaffold` project.
 */
describe('CLI', () => {
	const CLI = resolve(import.meta.dirname, '../../../test/scaffold/harness-env.ts');
	const run = (extra: Record<string, string>) => {
		const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
		return spawnSync(process.execPath, [CLI, 'env'], { env: { ...env, ...extra }, encoding: 'utf8' });
	};

	it('prints KEY=value lines for every scaffold variable', () => {
		const r = run({});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('SCAFFOLD_COMPOSE_PROJECT=codegen-scaffold-');
		expect(r.stdout).not.toMatch(/^(COMPOSE_PROJECT_NAME|DATABASE_URL)=/m);
	});

	it('exits non-zero with empty stdout on an invalid SCAFFOLD_PG_PORT', () => {
		const r = run({ SCAFFOLD_PG_PORT: 'abc' });
		expect(r.status).not.toBe(0);
		expect(r.stdout).toBe('');
	});
});
