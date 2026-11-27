/**
 * `CONSUMER_INSTALL_LINES` (src/cli/shared/init-scaffold.ts) are the install lines `project init` prints. A new user
 * reads them in docs/CONSUMER-SETUP.md › Start a project; this holds the doc to the constant, so the two cannot drift
 * (the 0.35.0 rehearsal found the doc had a prerequisites list and no command, and no @nestjs/platform-express).
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { CONSUMER_INSTALL_LINES, PATTERN_STACK_INSTALL_LINES } from '../../cli/shared/init-scaffold.js';

const REPO = path.resolve(import.meta.dir, '../../..');
const doc = fs.readFileSync(path.join(REPO, 'docs/CONSUMER-SETUP.md'), 'utf-8');

describe('docs/CONSUMER-SETUP.md carries the install lines project init prints', () => {
	it.each([...CONSUMER_INSTALL_LINES, ...PATTERN_STACK_INSTALL_LINES].map((l) => [l]))('%s', (line) => {
		expect(doc.split('\n')).toContain(line);
	});

	it('the pattern-stack lines install no Nest and the same drizzle pins (PW-4)', () => {
		expect(PATTERN_STACK_INSTALL_LINES.join(' ')).not.toMatch(/@nestjs|reflect-metadata/);
		expect(PATTERN_STACK_INSTALL_LINES[0]).toContain('@pattern-stack/wiring');
		expect(PATTERN_STACK_INSTALL_LINES[1]).toBe(CONSUMER_INSTALL_LINES[1]);
		expect(PATTERN_STACK_INSTALL_LINES[0]).toContain(CONSUMER_INSTALL_LINES[0].match(/drizzle-orm@\S+/)![0]);
	});

	it('installs the platform adapter the generated main.ts boots on', () => {
		expect(CONSUMER_INSTALL_LINES[0]).toContain('@nestjs/platform-express@');
	});

	it('pins the drizzle prerelease exactly, at the version the package is built against', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8')) as {
			devDependencies: Record<string, string>;
		};
		expect(CONSUMER_INSTALL_LINES[0]).toContain(`drizzle-orm@${pkg.devDependencies['drizzle-orm']}`);
		expect(CONSUMER_INSTALL_LINES[1]).toContain(`drizzle-kit@${pkg.devDependencies['drizzle-kit']}`);
	});

	it('says one init command everywhere: README and CONSUMER-SETUP name `codegen project init`', () => {
		const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf-8');
		for (const text of [readme, doc]) {
			expect(text).toContain('codegen project init');
			// `codegen init` appears only where it is named as the alias.
			for (const m of text.matchAll(/codegen init\b/g)) {
				const around = text.slice(Math.max(0, m.index! - 40), m.index! + 60);
				expect(around).toMatch(/alias/);
			}
		}
	});
});
