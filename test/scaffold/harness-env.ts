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
 * Every derived value honours an explicit override, so CI and anyone
 * debugging by hand can still pin them. The overrides are SCAFFOLD_-prefixed on
 * purpose, never the generic `COMPOSE_PROJECT_NAME` / `DATABASE_URL`: a shell
 * that exports those for some other stack would otherwise point this harness —
 * and its `docker compose down -v` — at that stack's project or database.
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
 * only ever touch this checkout's containers, volumes and network. Pinned by
 * `SCAFFOLD_COMPOSE_PROJECT` — deliberately not the generic
 * `COMPOSE_PROJECT_NAME`, which an unrelated stack may have exported.
 */
export function composeProjectName(env: NodeJS.ProcessEnv = process.env): string {
	return env.SCAFFOLD_COMPOSE_PROJECT || `codegen-scaffold-${checkoutId()}`;
}

/** The derived-port window: [PORT_BASE, PORT_BASE + PORT_SLOTS). See `scaffoldPgPort`. */
export const PORT_BASE = 20000;
export const PORT_SLOTS = 10000;

/**
 * The host port this checkout's scaffold Postgres publishes on.
 *
 * Derived rather than fixed at 5432 so sibling checkouts can run
 * `just test-integration` at the same time instead of failing to bind. The
 * window is 20000-29999: well above the common Postgres ports and below
 * Linux's default ephemeral range (32768-60999), so nothing transient steals
 * it. 10 000 slots put the chance of any collision among a dozen worktrees
 * under 1% (a 500-slot window was ~12%).
 *
 * A collision still fails loudly at `up --wait` rather than corrupting
 * anything. Set `SCAFFOLD_PG_PORT` to resolve it.
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
	return PORT_BASE + (parseInt(checkoutId().slice(0, 6), 16) % PORT_SLOTS);
}

/**
 * The connection string for this checkout's scaffold Postgres.
 *
 * Pinned by `SCAFFOLD_DATABASE_URL` — deliberately not an ambient
 * `DATABASE_URL`, which would win while the container publishes the derived
 * port, so the suite would silently run against (and truncate) a dev database.
 * Every scaffold consumer — the tests' `setup.ts`, the scaffold
 * `DatabaseModule`, `drizzle.config.ts` — calls this rather than reading
 * `DATABASE_URL`.
 */
export function scaffoldDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.SCAFFOLD_DATABASE_URL ||
		`postgresql://postgres:postgres@localhost:${scaffoldPgPort(env)}/scaffold_test`
	);
}

/**
 * The environment every scaffold subprocess needs: the compose file reads
 * `SCAFFOLD_PG_PORT` for its published port, and the tests, `drizzle-kit` and
 * the scaffold app resolve the URL through `scaffoldDatabaseUrl()`, which reads
 * `SCAFFOLD_DATABASE_URL`. Handing children the resolved values means a child
 * cannot re-derive a different answer from a different cwd or env.
 */
export function scaffoldEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	return {
		SCAFFOLD_COMPOSE_PROJECT: composeProjectName(env),
		SCAFFOLD_PG_PORT: String(scaffoldPgPort(env)),
		SCAFFOLD_DATABASE_URL: scaffoldDatabaseUrl(env),
	};
}

// --- CLI ---------------------------------------------------------------------
// `just` recipes shell out to this so the justfile and the TypeScript harness
// cannot drift into two derivations of the same name. An invalid override
// throws, so the process exits non-zero with nothing on stdout — the recipes
// treat that as fatal (they must never fall back to a default project name).

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
