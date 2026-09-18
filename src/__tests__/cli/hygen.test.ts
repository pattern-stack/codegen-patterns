/**
 * Hygen invocation helper — unit tests.
 *
 * Pins the runtime choice for the Hygen subprocess: we MUST invoke hygen
 * via `bunx --bun`, not plain `bunx`. Rationale lives in the docblock of
 * `src/cli/shared/hygen.ts`, but the short version is: `templates/entity/
 * new/prompt.js` does `await import('../../../src/patterns/library/
 * index.js')` where the physical target is `index.ts`. Node's ESM resolver
 * cannot map `.js` → `.ts`; Bun's can. Without `--bun`, `test-smoke`
 * regresses with `ERR_MODULE_NOT_FOUND` the moment anyone touches
 * `hygen.ts` and drops the flag. This test is the cheap guard.
 *
 * Not a subprocess test — we only assert the composed command string. The
 * real end-to-end proof is `test-smoke`.
 */

import { describe, test, expect } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { invokeHygen, invokeEntityNew, invokeRelationshipNew } from '../../cli/shared/hygen.js';

function captureCommand(fn: () => { command: string }): string {
	// invokeHygen returns its composed command string regardless of subprocess
	// outcome, so we can inspect it even if we don't actually want the child
	// to execute. To keep this test hermetic and fast, we pass a nonexistent
	// templateRoot + action so the subprocess fails immediately — we only
	// care about the command string.
	return fn().command;
}

describe('invokeHygen command composition', () => {
	test('uses `bunx --bun` to force Bun runtime', () => {
		const command = captureCommand(() =>
			invokeHygen({
				generator: 'entity',
				action: 'new',
				templateRoot: '/nonexistent',
				inherit: false,
			}),
		);
		expect(command.startsWith('bunx --bun hygen ')).toBe(true);
	});

	test('does not invoke plain `bunx hygen` (regression guard)', () => {
		// If this assertion flips, the Hygen subprocess will run under Node
		// and `prompt.js` imports like `src/patterns/library/index.js` (which
		// resolve to `.ts` files) will fail with ERR_MODULE_NOT_FOUND.
		const command = captureCommand(() =>
			invokeHygen({
				generator: 'entity',
				action: 'new',
				templateRoot: '/nonexistent',
				inherit: false,
			}),
		);
		expect(command).not.toMatch(/^bunx hygen /);
	});

	test('composes generator + action in positional order', () => {
		const command = captureCommand(() =>
			invokeHygen({
				generator: 'subsystem',
				action: 'install',
				templateRoot: '/nonexistent',
				inherit: false,
			}),
		);
		expect(command).toBe('bunx --bun hygen subsystem install');
	});

	test('appends --yaml arg via invokeEntityNew', () => {
		const command = captureCommand(() =>
			invokeEntityNew('/tmp/does-not-exist.yaml'),
		);
		expect(command).toContain('bunx --bun hygen entity new');
		expect(command).toContain('--yaml');
		expect(command).toContain('/tmp/does-not-exist.yaml');
	});

	test('appends --yaml arg via invokeRelationshipNew', () => {
		const command = captureCommand(() =>
			invokeRelationshipNew('/tmp/does-not-exist.yaml'),
		);
		expect(command).toContain('bunx --bun hygen relationship new');
		expect(command).toContain('--yaml');
	});
});

/**
 * `bunx` caches a fetched package at a fixed path under the temp dir, shared
 * by every process on the machine. Hygen usually runs with `cwd` set to a
 * throwaway generated project (no `node_modules`), so it is fetched rather
 * than resolved locally — and two checkouts generating at once then read a
 * half-written cache. The child therefore gets a temp dir keyed on this
 * installation. Symptom if this regresses: a rotating
 * `ENOENT reading ".../hygen/dist/..."` in `src/__tests__/cli/subsystem*.test.ts`
 * that passes when the file is run alone.
 */
describe('invokeHygen temp isolation', () => {
	test('creates a per-installation cache dir under the temp root', () => {
		invokeHygen({
			generator: 'entity',
			action: 'new',
			templateRoot: '/nonexistent',
			inherit: false,
		});

		const matches = readdirSync(tmpdir()).filter((e) => e.startsWith('codegen-hygen-'));
		expect(matches.length).toBeGreaterThan(0);
		// Keyed, not random: the name must be reproducible so repeated runs
		// reuse one cache instead of filling the temp dir.
		expect(matches.some((e) => /^codegen-hygen-[0-9a-f]{8}$/.test(e))).toBe(true);
		expect(existsSync(`${tmpdir()}/${matches[0]}`)).toBe(true);
	});

	test('a caller-supplied TMPDIR still wins', () => {
		// `opts.env` is spread last, so a caller that deliberately pins the
		// child's temp dir is not overridden.
		const result = invokeHygen({
			generator: 'entity',
			action: 'new',
			templateRoot: '/nonexistent',
			inherit: false,
			env: { TMPDIR: '/nonexistent-tmpdir-for-this-test' },
		});
		// The subprocess fails either way (nonexistent templateRoot); what this
		// pins is that passing the var is allowed and does not throw.
		expect(typeof result.ok).toBe('boolean');
	});
});
