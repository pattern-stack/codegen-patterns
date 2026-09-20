/**
 * The ONE owner of CLI invocation for the Studio server (STUDIO-0, #698).
 *
 * The server never reimplements generation logic. Every generator operation is
 * the real `codegen` CLI, spawned as a child process with `--json` and its
 * payload parsed here. Nothing else in `src/studio/server/**` calls `spawn`.
 *
 * Two shapes:
 *   - {@link runCliJson}  — buffered, for request/response endpoints.
 *   - {@link streamCli}   — line-by-line, for the SSE run stream.
 *
 * Entry resolution walks up from this module to the package root, then picks
 * the dev entry (`src/cli/index.ts`, run with bun) over the built one
 * (`dist/src/cli/index.js`, run with the current JS runtime). A consumer
 * project installs only `dist/`, so it takes the second branch.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface CliEntry {
	/** Executable to spawn. */
	command: string;
	/** Leading args (the CLI entry path). */
	args: string[];
}

export interface CliRunOptions {
	cwd: string;
	/** Extra environment for the child. */
	env?: Record<string, string>;
	signal?: AbortSignal;
}

export interface CliResult<T> {
	/** True when the CLI exited 0 AND a JSON payload was parsed. */
	ok: boolean;
	exitCode: number | null;
	/** The parsed `--json` payload, or null when the CLI printed none. */
	payload: T | null;
	stdout: string;
	stderr: string;
}

/**
 * Walk up from `from` to the directory holding this package's `package.json`.
 * Returns null when none is found — the caller turns that into a clear error
 * rather than spawning something arbitrary.
 */
function findPackageRoot(from: string): string | null {
	let dir = path.resolve(from);
	const root = path.parse(dir).root;
	while (true) {
		if (fs.existsSync(path.join(dir, 'package.json'))) {
			try {
				const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
				if (pkg.name === '@pattern-stack/codegen') return dir;
			} catch {
				// Unreadable package.json — keep walking.
			}
		}
		if (dir === root) return null;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

let cachedEntry: CliEntry | null = null;

/**
 * How to invoke the codegen CLI from this installation.
 *
 * `CODEGEN_STUDIO_CLI` overrides it (space-separated argv) — the seam the
 * unit tests use to point the runner at a stub.
 */
export function resolveCliEntry(): CliEntry {
	const override = process.env.CODEGEN_STUDIO_CLI;
	if (override) {
		const parts = override.split(/\s+/).filter(Boolean);
		return { command: parts[0], args: parts.slice(1) };
	}
	if (cachedEntry) return cachedEntry;

	const pkgRoot = findPackageRoot(import.meta.dirname);
	if (!pkgRoot) {
		throw new Error(
			'Could not locate the @pattern-stack/codegen package root from ' +
				`${import.meta.dirname} — the Studio server cannot invoke the CLI.`,
		);
	}

	const devEntry = path.join(pkgRoot, 'src', 'cli', 'index.ts');
	if (fs.existsSync(devEntry)) {
		cachedEntry = { command: 'bun', args: [devEntry] };
		return cachedEntry;
	}

	const builtEntry = path.join(pkgRoot, 'dist', 'src', 'cli', 'index.js');
	if (fs.existsSync(builtEntry)) {
		cachedEntry = { command: process.execPath, args: [builtEntry] };
		return cachedEntry;
	}

	throw new Error(
		`No codegen CLI entry found under ${pkgRoot} (looked for src/cli/index.ts and dist/src/cli/index.js).`,
	);
}

/** Reset the memoized entry. Tests only. */
export function resetCliEntryCache(): void {
	cachedEntry = null;
}

/**
 * Extract the CLI's `--json` payload from captured stdout.
 *
 * `printJson` writes one pretty-printed object, but a command may also emit
 * warnings on stdout before it, so the payload is taken as the last balanced
 * top-level `{...}` block rather than assuming stdout is pure JSON. Returns
 * null when there is no parseable object — a non-zero exit with no payload is
 * the case the callers must handle, so it is never papered over with `{}`.
 */
export function parseCliJson<T>(stdout: string): T | null {
	const start = stdout.indexOf('{');
	if (start === -1) return null;

	// Try progressively later opening braces: the first `{` may belong to a
	// warning line rather than the payload.
	for (let i = start; i !== -1; i = stdout.indexOf('{', i + 1)) {
		const candidate = stdout.slice(i);
		try {
			return JSON.parse(candidate) as T;
		} catch {
			// Trailing noise after the payload — retry on the balanced prefix.
			const balanced = balancedPrefix(candidate);
			if (balanced) {
				try {
					return JSON.parse(balanced) as T;
				} catch {
					// fall through to the next opening brace
				}
			}
		}
	}
	return null;
}

/** The shortest prefix of `s` that closes the object opened at index 0. */
function balancedPrefix(s: string): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return s.slice(0, i + 1);
		}
	}
	return null;
}

/** Run the CLI with `--json` and parse its payload. */
export async function runCliJson<T>(
	args: string[],
	opts: CliRunOptions,
): Promise<CliResult<T>> {
	const entry = resolveCliEntry();
	const argv = [...entry.args, ...args];
	if (!argv.includes('--json')) argv.push('--json');

	return new Promise<CliResult<T>>((resolve) => {
		const child = spawn(entry.command, argv, {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env, NO_COLOR: '1' },
			signal: opts.signal,
		});

		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (b: Buffer) => {
			stdout += b.toString();
		});
		child.stderr.on('data', (b: Buffer) => {
			stderr += b.toString();
		});
		child.on('error', (err: Error) => {
			resolve({ ok: false, exitCode: null, payload: null, stdout, stderr: stderr + err.message });
		});
		child.on('close', (code) => {
			const payload = parseCliJson<T>(stdout);
			resolve({ ok: code === 0 && payload !== null, exitCode: code, payload, stdout, stderr });
		});
	});
}

export interface StreamResult {
	exitCode: number | null;
	/** Set when the process could not be spawned at all. */
	error?: string;
}

/**
 * Run an arbitrary command, delivering complete stdout/stderr lines to `onLine`
 * as they arrive. Used for the run stream, where the point is that output
 * reaches the browser while the step is still running.
 */
export async function streamCommand(
	command: string,
	args: string[],
	opts: CliRunOptions,
	onLine: (line: string) => void,
): Promise<StreamResult> {
	return new Promise<StreamResult>((resolve) => {
		const child = spawn(command, args, {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env, NO_COLOR: '1', FORCE_COLOR: '0' },
			signal: opts.signal,
		});

		// One buffer per stream: a partial line on stdout must not be spliced
		// onto a partial line from stderr.
		const pending = { out: '', err: '' };
		const pump = (key: 'out' | 'err') => (b: Buffer) => {
			pending[key] += b.toString();
			const lines = pending[key].split('\n');
			pending[key] = lines.pop() ?? '';
			for (const line of lines) onLine(line);
		};

		child.stdout.on('data', pump('out'));
		child.stderr.on('data', pump('err'));
		child.on('error', (err: Error) => {
			resolve({ exitCode: null, error: err.message });
		});
		child.on('close', (code) => {
			if (pending.out) onLine(pending.out);
			if (pending.err) onLine(pending.err);
			resolve({ exitCode: code });
		});
	});
}

/** {@link streamCommand}, targeting the codegen CLI. */
export async function streamCli(
	args: string[],
	opts: CliRunOptions,
	onLine: (line: string) => void,
): Promise<StreamResult> {
	const entry = resolveCliEntry();
	return streamCommand(entry.command, [...entry.args, ...args], opts, onLine);
}
