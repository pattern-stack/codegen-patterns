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
