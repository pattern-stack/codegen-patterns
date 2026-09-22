/**
 * The Studio demo project (STUDIO-0, #698).
 *
 * One function builds it, and both `just studio-demo` and the end-to-end test
 * call it — so what the test proves and what the owner demos are the same
 * project, not two that drifted.
 *
 * The entity set (account / contact / opportunity) is deliberately incomplete:
 * there is no contact ↔ opportunity link. Adding it through the Studio
 * relationship form is the demo.
 *
 * The project gets its own git repo with one commit, because `/api/diff` is a
 * real `git diff` in it — the baseline commit is what the diff pane shows
 * changes against.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolveCliEntry } from '../server/cli-runner.js';

/**
 * The drizzle versions the generator itself is built against. Pinning the demo
 * to these is the whole point: a kit from a different line produces
 * "unresolved decisions" against this ORM's schema output.
 */
function pinnedDrizzleVersions(): { kit: string; orm: string } {
	const pkgPath = path.resolve(import.meta.dirname, '..', '..', '..', 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
		devDependencies?: Record<string, string>;
	};
	const dev = pkg.devDependencies ?? {};
	return { kit: dev['drizzle-kit'] ?? '1.0.0-rc.4', orm: dev['drizzle-orm'] ?? '1.0.0-rc.4' };
}

export interface MaterializeOptions {
	/** Where to build the project. Created if missing; reused if present. */
	targetDir: string;
	/** Initialize a git repo and commit the baseline. Default true. */
	git?: boolean;
	/** Run `entity new --all` after copying the entities. Default true. */
	generate?: boolean;
	/**
	 * Postgres to point the project at. When set, a `drizzle.config.ts` and a
	 * `.env` are written and `drizzle-kit` + `drizzle-orm` are installed at the
	 * generator's own pinned versions — so Studio's `dbPush` step runs the
	 * PROJECT's kit (`bunx --no-install`), never a `@latest` fetched into a
	 * shared cache (#688).
	 */
	databaseUrl?: string;
	/** Receives each command as it runs. Default: silent. */
	onLog?: (line: string) => void;
}

export interface MaterializeResult {
	projectDir: string;
	entityFiles: string[];
	generated: boolean;
	gitInitialized: boolean;
	/** True when a drizzle config was written and the kit installed. */
	dbConfigured: boolean;
}

/** The checked-in demo entity YAMLs. */
export function demoEntitiesDir(): string {
	return path.join(import.meta.dirname, 'entities');
}

function run(
	command: string,
	args: string[],
	cwd: string,
	onLog?: (line: string) => void,
): void {
	onLog?.(`$ ${command} ${args.join(' ')}`);
	const res = spawnSync(command, args, {
		cwd,
		encoding: 'utf-8',
		env: { ...process.env, NO_COLOR: '1' },
	});
	if (res.status !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed (${res.status}):\n${res.stderr || res.stdout}`,
		);
	}
	if (res.stdout && onLog) onLog(res.stdout.trimEnd());
}

export function materializeDemoProject(options: MaterializeOptions): MaterializeResult {
	const projectDir = path.resolve(options.targetDir);
	const doGit = options.git ?? true;
	const doGenerate = options.generate ?? true;
	const log = options.onLog;

	fs.mkdirSync(projectDir, { recursive: true });

	// A package.json so the project is a real node package — `project init`
	// writes none, and drizzle-kit / tsc would have nothing to anchor on.
	const pkgPath = path.join(projectDir, 'package.json');
	if (!fs.existsSync(pkgPath)) {
		fs.writeFileSync(
			pkgPath,
			JSON.stringify(
				{ name: 'codegen-studio-demo', private: true, type: 'module', version: '0.0.0' },
				null,
				2,
			) + '\n',
		);
	}

	const cli = resolveCliEntry();
	run(cli.command, [...cli.args, 'project', 'init', '--yes', '--with-tsconfig'], projectDir, log);

	// Copy the demo entities into whatever `project init` decided the entities
	// directory is, rather than assuming `entities/`.
	const entitiesDir = path.join(projectDir, 'entities');
	fs.mkdirSync(entitiesDir, { recursive: true });
	// `project init` seeds an `example.yaml`. The demo set is closed — and the
	// e2e asserts an entity count — so the placeholder goes.
	for (const stale of ['example.yaml', 'example.yml']) {
		fs.rmSync(path.join(entitiesDir, stale), { force: true });
	}
	const entityFiles: string[] = [];
	for (const name of fs.readdirSync(demoEntitiesDir()).sort()) {
		if (!/\.ya?ml$/.test(name)) continue;
		const dest = path.join(entitiesDir, name);
		fs.copyFileSync(path.join(demoEntitiesDir(), name), dest);
		entityFiles.push(dest);
	}
	log?.(`copied ${entityFiles.length} demo entities into ${entitiesDir}`);

	if (doGenerate) {
		// TWO passes, as `just test-baseline` does and for the same reason: a
		// `has_many` composition method is emitted only when its target entity
		// already exists on disk (`targetExists`, CGP-358b). On a fresh project
		// the first pass writes `account` before `contact` / `opportunity`
		// exist, so `AccountService.contacts()` / `.opportunities()` and their
		// injected repositories are omitted.
		//
		// Generating once would leave those missing from the BASELINE COMMIT,
		// so the owner's first Generate click in Studio would show two changed
		// files under `accounts/` that have nothing to do with what they just
		// did — at the climax of the demo, in the diff pane, on an entity they
		// never touched. The second pass settles them before the commit.
		for (const pass of [1, 2]) {
			log?.(`# generation pass ${pass} of 2`);
			run(cli.command, [...cli.args, 'entity', 'new', '--all', '--force'], projectDir, log);
		}
	}

	let dbConfigured = false;
	if (options.databaseUrl) {
		const { kit, orm } = pinnedDrizzleVersions();
		fs.writeFileSync(
			path.join(projectDir, 'drizzle.config.ts'),
			[
				"import { defineConfig } from 'drizzle-kit';",
				'',
				'export default defineConfig({',
				"  schema: './src/schema.ts',",
				"  out: './drizzle',",
				"  dialect: 'postgresql',",
				'  dbCredentials: {',
				"    url: process.env.DATABASE_URL ?? '" + options.databaseUrl + "',",
				'  },',
				'});',
				'',
			].join('\n'),
		);
		fs.writeFileSync(path.join(projectDir, '.env'), `DATABASE_URL=${options.databaseUrl}\n`);
		run('bun', ['add', '-d', `drizzle-kit@${kit}`, `drizzle-orm@${orm}`], projectDir, log);
		dbConfigured = true;
	}

	let gitInitialized = false;
	if (doGit && !fs.existsSync(path.join(projectDir, '.git'))) {
		run('git', ['init', '-q'], projectDir, log);
		run('git', ['add', '-A'], projectDir, log);
		// -c so the commit works on a host with no global git identity.
		run(
			'git',
			[
				'-c',
				'user.name=codegen studio',
				'-c',
				'user.email=studio@pattern-stack.invalid',
				'commit',
				'-q',
				'-m',
				'baseline: codegen studio demo project',
			],
			projectDir,
			log,
		);
		gitInitialized = true;
	}

	return { projectDir, entityFiles, generated: doGenerate, gitInitialized, dbConfigured };
}
