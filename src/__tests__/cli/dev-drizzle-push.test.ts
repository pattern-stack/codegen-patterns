/**
 * `codegen dev up`'s schema-push decision (#688 review nit 3).
 *
 * The push shells a drizzle-kit, so it cannot run in a unit test (it needs a
 * live Postgres and Docker). What IS unit-testable — and what the nit is about
 * — is WHICH command it would run, and that a fresh scaffold runs none.
 */

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzlePushPlan, drizzlePushWarning } from '../../cli/commands/dev';

describe('drizzlePushPlan', () => {
	it('plans nothing on a fresh scaffold — `project init` emits no drizzle.config.ts', () => {
		expect(drizzlePushPlan(mkdtempSync(join(tmpdir(), 'cgp-dev-')))).toBeNull();
	});

	it('uses the project\'s own drizzle-kit (`--no-install`), never a global @latest', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cgp-dev-'));
		writeFileSync(join(dir, 'drizzle.config.ts'), 'export default {};\n');
		const plan = drizzlePushPlan(dir);
		expect(plan?.configFile).toBe('drizzle.config.ts');
		expect(plan?.command).toBe('bunx --no-install drizzle-kit push --config drizzle.config.ts');
		expect(plan?.command).not.toMatch(/drizzle-kit@|@latest/);
	});

	it('accepts a .js config too', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cgp-dev-'));
		writeFileSync(join(dir, 'drizzle.config.js'), 'module.exports = {};\n');
		expect(drizzlePushPlan(dir)?.configFile).toBe('drizzle.config.js');
	});
});

describe('drizzlePushWarning', () => {
	// The failure a consumer actually meets under `--no-install` is "no kit
	// installed", so the warning has to name that cause.
	it('names drizzle-kit as the likely cause and keeps the underlying stderr', () => {
		const msg = drizzlePushWarning('error: could not resolve "drizzle-kit"');
		expect(msg).toContain('is drizzle-kit installed in this project?');
		expect(msg).toContain('could not resolve "drizzle-kit"');
	});

	it('truncates a long stderr', () => {
		expect(drizzlePushWarning('x'.repeat(500)).length).toBeLessThan(300);
	});
});
