/**
 * Hygen invocation helper — shared between `entity` and `subsystem` nouns.
 *
 * We shell out to `bunx --bun hygen <generator> <action>` with HYGEN_TMPLS
 * pointing at our templates directory.
 *
 * Why `--bun`: hygen's own shebang is `#!/usr/bin/env node`, so plain
 * `bunx hygen` runs the generator under Node. Our `prompt.js` files do
 * `await import('../../../src/patterns/library/index.js')` — where the
 * physical target is `index.ts`. Node's ESM resolver does not map `.js` to
 * `.ts`; Bun's does. `--bun` forces Bun to honor the invocation and the
 * `.js`-pointing-at-`.ts` imports (a convention that matches what the
 * TypeScript source itself uses internally — e.g. `import '../registry.js'`
 * inside a `.ts` file under NodeNext module resolution) resolve cleanly.
 *
 * Dropping `--bun` silently breaks `test-smoke` and any consumer path that
 * exercises the pattern registry through the Hygen subprocess. A
 * unit-level regression test pins the flag in
 * `src/__tests__/cli/hygen.test.ts`.
 */

import { execSync, type ExecSyncOptions } from 'node:child_process';
import { join } from 'node:path';

export interface HygenInvocation {
	/** e.g. 'entity' */
	generator: string;
	/** e.g. 'new' */
	action: string;
	/** Absolute path to the templates/ directory. Defaults to bundled templates. */
	templateRoot?: string;
	/** Extra positional args passed after `<generator> <action>` */
	args?: string[];
	/** Extra env vars merged onto process.env */
	env?: NodeJS.ProcessEnv;
	/** Working directory Hygen executes in. Defaults to process.cwd(). */
	cwd?: string;
	/** If false, suppresses child stdio inheritance. Defaults to true. */
	inherit?: boolean;
}

export interface HygenResult {
	ok: boolean;
	command: string;
	stdout?: string;
	stderr?: string;
}

function defaultTemplateRoot(): string {
	// src/cli/shared/hygen.ts → ../../../templates
	return join(import.meta.dirname, '..', '..', '..', 'templates');
}

function quoteArg(a: string): string {
	if (a === '' || /[\s"'$`\\]/.test(a)) {
		return `"${a.replace(/(["$`\\])/g, '\\$1')}"`;
	}
	return a;
}

/**
 * Invoke Hygen synchronously, inheriting stdio by default (so users see the
 * generator's own output). Returns {ok:false} on non-zero exit.
 */
export function invokeHygen(opts: HygenInvocation): HygenResult {
	const templateRoot = opts.templateRoot ?? defaultTemplateRoot();
	const extra = (opts.args ?? []).map(quoteArg).join(' ');
	const command = `bunx --bun hygen ${opts.generator} ${opts.action}${extra ? ' ' + extra : ''}`;

	const execOpts: ExecSyncOptions = {
		cwd: opts.cwd ?? process.cwd(),
		env: { ...process.env, HYGEN_TMPLS: templateRoot, ...(opts.env ?? {}) },
		stdio: opts.inherit === false ? 'pipe' : 'inherit',
	};

	try {
		const out = execSync(command, execOpts);
		return {
			ok: true,
			command,
			stdout: out ? out.toString() : undefined,
		};
	} catch (err: unknown) {
		const e = err as {
			stdout?: Buffer | string;
			stderr?: Buffer | string;
			message?: string;
		};
		return {
			ok: false,
			command,
			stdout: e.stdout ? e.stdout.toString() : undefined,
			stderr: e.stderr ? e.stderr.toString() : e.message,
		};
	}
}

/**
 * Convenience wrapper for the most common pattern — generating one entity
 * from a YAML path.
 */
export function invokeEntityNew(absoluteYamlPath: string, cwd?: string): HygenResult {
	return invokeHygen({
		generator: 'entity',
		action: 'new',
		args: ['--yaml', absoluteYamlPath],
		cwd,
	});
}

/**
 * Convenience wrapper for generating one relationship from a YAML path.
 */
export function invokeRelationshipNew(absoluteYamlPath: string, cwd?: string): HygenResult {
	return invokeHygen({
		generator: 'relationship',
		action: 'new',
		args: ['--yaml', absoluteYamlPath],
		cwd,
	});
}
