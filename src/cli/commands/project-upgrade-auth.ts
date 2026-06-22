/**
 * `codegen project upgrade-auth` — surgical codemod that wires the ADR-043
 * closed-by-default data plane into an existing consumer's `src/main.ts` +
 * `src/app.module.ts`, bringing them up to the shape `project init` now emits.
 *
 * Sibling of `project upgrade-openapi`; same ts-morph AST-patch toolkit, same
 * idempotent / surgical / honest-bail discipline.
 *
 * Behaviour:
 *   1. Resolve project root (`--path` or cwd, walking up for
 *      `codegen.config.yaml` / `package.json`); resolve the runtime mode so the
 *      auth import specifier matches package vs vendored.
 *   2. Patch `src/app.module.ts`:
 *        - Add `import { AuthModule } from '<auth-barrel>'`.
 *        - Insert `AuthModule.forRoot({...})` into `AppModule.imports` (binds the
 *          global AuthenticatedGuard via APP_GUARD).
 *   3. Patch `src/main.ts` (best-effort):
 *        - If `installRequesterContext(` already present → skip.
 *        - Else insert the RequesterContext boundary + boot-fail block after
 *          `NestFactory.create(...)`, plus the auth import.
 *   4. Report what changed, exit 0 on success, 1 on bail.
 *
 * It does NOT bind `AUTH_USER_CONTEXT` — that is always app-specific (the
 * consumer's session/JWT scheme). Until they bind it, the boot-fail block this
 * wires refuses to serve (the intended ADR-043 posture).
 *
 * `--dry-run` prints the diff but writes nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'clipanion';
import { Project, IndentationText, QuoteKind, NewLineKind } from 'ts-morph';

import { printError, printInfo, printSuccess, printWarning } from '../ui/output.js';
import { isJsonMode, printJson, setJsonMode } from '../ui/json.js';
import { theme } from '../ui/theme.js';
import { icons } from '../ui/icons.js';
import { resolveRuntimeMode, subsystemsImport } from '../shared/runtime-import.js';
import {
	ensureImport,
	ensureMainRequesterContextBlock,
	ensureModuleDynamicImportEntry,
	type PatchResult,
} from '../shared/ast-patch.js';

const CONSUMER_SETUP_POINTER =
	'For manual wiring, see docs/CONSUMER-SETUP.md §Auth or ' +
	'https://github.com/pattern-stack/codegen-patterns/blob/main/docs/CONSUMER-SETUP.md';

/** The dynamic-module entry inserted into AppModule.imports. */
const AUTH_MODULE_ENTRY = "AuthModule.forRoot({ encryptionKey: 'env', oauthStateStore: 'memory' })";

/**
 * The RequesterContext boundary + closed-by-default boot-fail block, inserted
 * after `NestFactory.create(...)`. Self-contained: it loads the `auth:` block
 * from `codegen.config.yaml` inline so it works in a hand-authored main.ts that
 * has no pre-existing `config` variable.
 */
const MAIN_AUTH_BLOCK = `  // ADR-043: bridge the verified principal into AsyncLocalStorage so every
  // downstream repository read/write is scoped with no threaded userId.
  installRequesterContext(app);

  // Closed-by-default data plane (ADR-043 §4). This is the HTTP entrypoint, so
  // an unauthenticated data plane here is a real exposure. Refuse to serve when
  // no IUserContext is bound, unless the localhost-only escape hatch is set.
  {
    const { parse: parseYaml } = await import('yaml');
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const cfgPath = pathMod.resolve(process.cwd(), 'codegen.config.yaml');
    const cfg: { auth?: { devAllowAnonymous?: boolean } } = fsMod.existsSync(cfgPath)
      ? (parseYaml(fsMod.readFileSync(cfgPath, 'utf-8')) ?? {})
      : {};
    const userContext = app.get(AUTH_USER_CONTEXT, { strict: false });
    const allowAnonymous = cfg.auth?.devAllowAnonymous === true;
    if (!userContext && !allowAnonymous) {
      throw new Error(
        '[auth] FATAL: entity HTTP controllers are exposed but no IUserContext ' +
          'is bound under AUTH_USER_CONTEXT. The data plane would be ' +
          'unauthenticated. Bind an IUserContext (install the auth subsystem, ' +
          'or provide your own), or set auth.devAllowAnonymous=true in ' +
          'codegen.config.yaml for LOCALHOST DEV ONLY.',
      );
    }
    if (!userContext && allowAnonymous) {
      // eslint-disable-next-line no-console
      console.warn(
        '[auth] auth.devAllowAnonymous=true — the data plane is UNAUTHENTICATED. ' +
          'This must never be set in a non-localhost deployment.',
      );
    }
  }
`;

function resolveProjectRoot(startDir: string): string {
	let dir = path.resolve(startDir);
	for (let i = 0; i < 16; i++) {
		if (
			fs.existsSync(path.join(dir, 'codegen.config.yaml')) ||
			fs.existsSync(path.join(dir, 'package.json'))
		) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return path.resolve(startDir);
}

function authBarrelImport(projectRoot: string): string {
	let raw: unknown = undefined;
	try {
		const cfgPath = path.join(projectRoot, 'codegen.config.yaml');
		if (fs.existsSync(cfgPath)) {
			// Lazy parse just for the runtime mode — avoids a hard yaml dep at module load.
			const text = fs.readFileSync(cfgPath, 'utf-8');
			raw = /^\s*runtime:\s*vendored\s*$/m.test(text) ? { runtime: 'vendored' } : { runtime: 'package' };
		}
	} catch {
		raw = undefined;
	}
	const mode = resolveRuntimeMode(raw as { runtime?: unknown });
	return mode === 'vendored' ? './shared/subsystems/auth' : subsystemsImport(mode, 'auth');
}

interface UpgradeChange {
	path: string;
	action: 'updated' | 'unchanged' | 'skipped';
	note?: string;
	diff?: string;
}

interface UpgradeReport {
	projectRoot: string;
	changes: UpgradeChange[];
	bail?: { file: string; reason: string };
}

export interface UpgradeAuthOptions {
	projectRoot: string;
	dryRun: boolean;
}

export async function runUpgradeAuth(opts: UpgradeAuthOptions): Promise<UpgradeReport> {
	const { projectRoot, dryRun } = opts;
	const changes: UpgradeChange[] = [];
	const authImport = authBarrelImport(projectRoot);

	const project = new Project({
		useInMemoryFileSystem: false,
		manipulationSettings: {
			indentationText: IndentationText.TwoSpaces,
			quoteKind: QuoteKind.Single,
			newLineKind: NewLineKind.LineFeed,
		},
		skipAddingFilesFromTsConfig: true,
		skipFileDependencyResolution: true,
		skipLoadingLibFiles: true,
	});

	// 1. Patch app.module.ts
	const appModulePath = path.join(projectRoot, 'src', 'app.module.ts');
	if (!fs.existsSync(appModulePath)) {
		return {
			projectRoot,
			changes,
			bail: {
				file: 'src/app.module.ts',
				reason: 'file does not exist — run `codegen project init` first, or author it manually',
			},
		};
	}

	const appSource = project.addSourceFileAtPath(appModulePath);
	const appBefore = appSource.getFullText();
	if (!appSource.getClass('AppModule')) {
		return {
			projectRoot,
			changes,
			bail: { file: 'src/app.module.ts', reason: 'no `AppModule` class found (factory function or unusual shape)' },
		};
	}

	const patches: PatchResult[] = [];
	patches.push(ensureImport(appSource, authImport, ['AuthModule']));
	const appModuleClass = appSource.getClass('AppModule')!;
	const entry = ensureModuleDynamicImportEntry(appModuleClass, 'AuthModule', AUTH_MODULE_ENTRY);
	patches.push(entry);
	if (entry.bail) {
		return { projectRoot, changes, bail: { file: 'src/app.module.ts', reason: entry.bail } };
	}

	const appAfter = appSource.getFullText();
	if (appAfter !== appBefore) {
		if (!dryRun) appSource.saveSync();
		changes.push({
			path: 'src/app.module.ts',
			action: 'updated',
			note: patches.filter((p) => p.changed).map((p) => p.note).filter(Boolean).join('; '),
			diff: simpleDiff(appBefore, appAfter),
		});
	} else {
		changes.push({ path: 'src/app.module.ts', action: 'unchanged' });
	}

	// 2. Patch main.ts (best-effort)
	const mainPath = path.join(projectRoot, 'src', 'main.ts');
	if (fs.existsSync(mainPath)) {
		const mainSource = project.addSourceFileAtPath(mainPath);
		const mainBefore = mainSource.getFullText();
		const result = ensureMainRequesterContextBlock(mainSource, {
			authImport,
			block: MAIN_AUTH_BLOCK,
		});
		if (result.bail) {
			changes.push({ path: 'src/main.ts', action: 'skipped', note: `${result.bail} — see CONSUMER-SETUP §Auth` });
		} else if (result.changed) {
			const mainAfter = mainSource.getFullText();
			if (!dryRun) mainSource.saveSync();
			changes.push({ path: 'src/main.ts', action: 'updated', note: result.note, diff: simpleDiff(mainBefore, mainAfter) });
		} else {
			changes.push({ path: 'src/main.ts', action: 'unchanged', note: result.note });
		}
	} else {
		changes.push({ path: 'src/main.ts', action: 'skipped', note: "does not exist — run `codegen project init` to scaffold" });
	}

	return { projectRoot, changes };
}

function simpleDiff(before: string, after: string): string {
	const b = before.split('\n');
	const a = after.split('\n');
	const bSet = new Set(b);
	const aSet = new Set(a);
	const added = a.filter((l) => !bSet.has(l)).map((l) => '+ ' + l);
	const removed = b.filter((l) => !aSet.has(l)).map((l) => '- ' + l);
	if (added.length === 0 && removed.length === 0) return '';
	return [...removed, ...added].join('\n');
}

export class ProjectUpgradeAuthCommand extends Command {
	static paths = [['project', 'upgrade-auth']];
	static usage = Command.Usage({
		description:
			'Patch an existing consumer app.module.ts + main.ts to wire AuthModule + the closed-by-default auth guard (ADR-043)',
		examples: [
			['Patch the current project', 'codegen project upgrade-auth'],
			['Preview changes without writing', 'codegen project upgrade-auth --dry-run'],
			['Target a specific project dir', 'codegen project upgrade-auth --path ./apps/api'],
		],
	});

	dryRun = Option.Boolean('--dry-run', false);
	pathOpt = Option.String('--path', { required: false });
	json = Option.Boolean('--json', false);

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);

		const startDir = this.pathOpt ? path.resolve(this.pathOpt) : process.cwd();
		if (!fs.existsSync(startDir)) {
			printError(`Directory not found: ${startDir}`);
			return 1;
		}
		const projectRoot = resolveProjectRoot(startDir);

		let report: UpgradeReport;
		try {
			report = await runUpgradeAuth({ projectRoot, dryRun: this.dryRun });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			printError(`upgrade-auth failed: ${msg}`);
			process.stderr.write(`\n${CONSUMER_SETUP_POINTER}\n`);
			return 1;
		}

		if (isJsonMode()) {
			printJson({
				command: 'project upgrade-auth',
				projectRoot: report.projectRoot,
				dryRun: this.dryRun,
				changes: report.changes,
				bail: report.bail ?? null,
			});
			return report.bail ? 1 : 0;
		}

		printInfo(`Auth upgrade summary (${report.projectRoot}):`);
		console.log('');
		for (const c of report.changes) {
			const icon =
				c.action === 'updated'
					? theme.success(icons.check)
					: c.action === 'skipped'
						? theme.warning(icons.warning)
						: theme.muted(icons.dash);
			const tag = c.action.padEnd(10);
			const reason = c.note ? theme.muted(`  (${c.note})`) : '';
			console.log(`  ${icon} ${theme.muted(tag)} ${c.path}${reason}`);
			if (this.dryRun && c.diff) {
				for (const line of c.diff.split('\n').slice(0, 24)) {
					const colored = line.startsWith('+')
						? theme.success(line)
						: line.startsWith('-')
							? theme.error(line)
							: line;
					console.log(`      ${colored}`);
				}
			}
		}

		if (report.bail) {
			console.log('');
			printError(`bail: ${report.bail.file} — ${report.bail.reason}`);
			process.stderr.write('\n' + CONSUMER_SETUP_POINTER + '\n');
			return 1;
		}

		console.log('');
		if (this.dryRun) {
			printWarning('dry-run — no files written');
		} else {
			printSuccess('upgrade-auth complete');
		}
		console.log('');
		printInfo('Next step: bind an IUserContext under AUTH_USER_CONTEXT in your AppModule');
		console.log(
			`  (your session/JWT scheme) — until then the data plane refuses to serve. ${theme.muted('ADR-043 §4')}`,
		);
		return 0;
	}
}
