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
import {
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

	it('honours an explicit COMPOSE_PROJECT_NAME', () => {
		expect(composeProjectName({ COMPOSE_PROJECT_NAME: 'pinned' })).toBe('pinned');
	});
});

describe('scaffoldPgPort', () => {
	it('lands below the Linux ephemeral range and above the common Postgres ports', () => {
		const port = scaffoldPgPort(EMPTY);
		expect(port).toBeGreaterThanOrEqual(15500);
		expect(port).toBeLessThan(16000);
		// 32768 is the low end of the default ip_local_port_range; a published
		// port inside it can be stolen by a transient outbound socket.
		expect(port).toBeLessThan(32768);
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

	it('honours an explicit DATABASE_URL', () => {
		const url = 'postgresql://u:p@db.example:6000/other';
		expect(scaffoldDatabaseUrl({ DATABASE_URL: url })).toBe(url);
	});
});

describe('scaffoldEnv', () => {
	it('carries every name a scaffold subprocess needs', () => {
		expect(Object.keys(scaffoldEnv(EMPTY)).sort()).toEqual([
			'COMPOSE_PROJECT_NAME',
			'DATABASE_URL',
			'SCAFFOLD_PG_PORT',
		]);
	});

	it('agrees with the individual accessors', () => {
		const env = scaffoldEnv(EMPTY);
		expect(env.COMPOSE_PROJECT_NAME).toBe(composeProjectName(EMPTY));
		expect(env.SCAFFOLD_PG_PORT).toBe(String(scaffoldPgPort(EMPTY)));
		expect(env.DATABASE_URL).toBe(scaffoldDatabaseUrl(EMPTY));
	});

	it('the URL port and the published port are the same number', () => {
		// The compose file publishes SCAFFOLD_PG_PORT; every client reads
		// DATABASE_URL. If these ever disagree the suite connects to nothing.
		const env = scaffoldEnv(EMPTY);
		expect(new URL(env.DATABASE_URL!).port).toBe(env.SCAFFOLD_PG_PORT);
	});
});
