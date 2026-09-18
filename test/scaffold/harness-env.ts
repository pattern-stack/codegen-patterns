#!/usr/bin/env bun
/**
 * Per-checkout harness identity.
 *
 * Several agents run gates concurrently in sibling git worktrees on one
 * machine. Anything the harness names with a fixed global string is therefore
 * shared between checkouts, and one run destroys another's state. This module
 * is the single place those names are derived, so there is exactly one answer
 * to "which Postgres is mine".
 *
 * The concrete failure this fixes: `test/scaffold/docker-compose.yml` has no
 * `name:`, so Compose derives the project name from the directory — `scaffold`
 * in every worktree. Sibling runs then share one container, one volume and one
 * network, and whichever finishes first runs `docker compose down -v` on the
 * other's database. Observed as `missing_hints` from `drizzle-kit push` (a
 * half-created schema), `network scaffold_default not found` while starting,
 * and whole suites dying on `Connection terminated unexpectedly` mid-run.
 *
 * Every derived value honours an explicit environment override, so CI and
 * anyone debugging by hand can still pin them.
 *
 * Usage as a module:  import { composeProjectName, scaffoldDatabaseUrl } from './harness-env'
 * Usage as a CLI:     bun test/scaffold/harness-env.ts <project|port|url|env>
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** The checkout this file belongs to — NOT `process.cwd()`, which varies per harness. */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * A short, stable, filesystem- and Compose-safe id for this checkout.
 *
 * Keyed on the resolved absolute path, so two worktrees of the same repo get
 * different ids while repeated runs of one worktree get the same id (the
 * container is reused, and teardown finds what setup created).
 */
export function checkoutId(root: string = REPO_ROOT): string {
	let real = root;
	try {
		real = realpathSync(root);
	} catch {
		// A path that cannot be resolved still hashes fine; determinism is all
		// this needs, and a missing root is the caller's problem, not ours.
	}
	return createHash('sha256').update(real).digest('hex').slice(0, 8);
}

/**
 * The Docker Compose project name for this checkout's scaffold Postgres.
 *
 * Passed explicitly as `-p` on every compose call, so `up` and `down -v` can
 * only ever touch this checkout's containers, volumes and network.
 */
export function composeProjectName(env: NodeJS.ProcessEnv = process.env): string {
	return env.COMPOSE_PROJECT_NAME || `codegen-scaffold-${checkoutId()}`;
}

/**
 * The host port this checkout's scaffold Postgres publishes on.
 *
 * Derived rather than fixed at 5432 so sibling checkouts can run
 * `just test-integration` at the same time instead of failing to bind. The
 * window is 15500-15999: above the common Postgres ports and below Linux's
 * default ephemeral range (32768-60999), so nothing transient steals it.
 *
 * Two checkouts colliding here is possible but improbable, and it fails loudly
 * at `up --wait` rather than corrupting anything. Set `SCAFFOLD_PG_PORT` to
 * resolve it.
 */
export function scaffoldPgPort(env: NodeJS.ProcessEnv = process.env): number {
	const override = env.SCAFFOLD_PG_PORT;
	if (override) {
		const parsed = Number(override);
		if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
			throw new Error(`SCAFFOLD_PG_PORT must be a port number, got '${override}'`);
		}
		return parsed;
	}
	return 15500 + (parseInt(checkoutId().slice(0, 4), 16) % 500);
}

/** The connection string for this checkout's scaffold Postgres. */
export function scaffoldDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.DATABASE_URL ||
		`postgresql://postgres:postgres@localhost:${scaffoldPgPort(env)}/scaffold_test`
	);
}

/**
 * The environment every scaffold subprocess needs: the compose file reads
 * `SCAFFOLD_PG_PORT` for its published port, and the tests, `drizzle-kit` and
 * the generated app all read `DATABASE_URL`.
 */
export function scaffoldEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	return {
		COMPOSE_PROJECT_NAME: composeProjectName(env),
		SCAFFOLD_PG_PORT: String(scaffoldPgPort(env)),
		DATABASE_URL: scaffoldDatabaseUrl(env),
	};
}

// --- CLI ---------------------------------------------------------------------
// `just` recipes shell out to this so the justfile and the TypeScript harness
// cannot drift into two derivations of the same name.

if (import.meta.main) {
	const what = process.argv[2] ?? 'env';
	const out: Record<string, string> = {
		project: composeProjectName(),
		port: String(scaffoldPgPort()),
		url: scaffoldDatabaseUrl(),
	};
	if (what === 'env') {
		for (const [k, v] of Object.entries(scaffoldEnv())) console.log(`${k}=${v}`);
	} else if (what in out) {
		console.log(out[what]);
	} else {
		console.error(`usage: bun test/scaffold/harness-env.ts <project|port|url|env>`);
		process.exit(2);
	}
}
