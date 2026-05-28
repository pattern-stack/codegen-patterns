/**
 * Unit tests for the skills noun — the consumer-skill vendoring that backs
 * `codegen skills install` (and is reused by `project init` + `codegen update`).
 */

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import skillsNoun from '../../cli/commands/skills.js';
import {
	availableSkills,
	consumerSkillsRoot,
	runSkillsInstall,
	skillsTargetDir,
} from '../../cli/commands/skills.js';

const tempDirs: string[] = [];
function mkTemp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-cli-'));
	tempDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('skills noun', () => {
	test('exports name=skills with install + list commands', () => {
		expect(skillsNoun.name).toBe('skills');
		expect(skillsNoun.commandClasses.length).toBe(2);
	});

	test('consumer-skills source bundles the expected skill set', () => {
		const root = consumerSkillsRoot();
		expect(fs.existsSync(root)).toBe(true);
		const names = availableSkills();
		// The vendored router + the focused domain skills.
		for (const expected of ['codegen', 'entities', 'subsystems', 'jobs', 'events', 'bridge', 'sync']) {
			expect(names).toContain(expected);
		}
	});

	test('every bundled SKILL.md carries frontmatter + the managed-by header', () => {
		const root = consumerSkillsRoot();
		for (const name of availableSkills()) {
			const skill = path.join(root, name, 'SKILL.md');
			expect(fs.existsSync(skill)).toBe(true);
			const text = fs.readFileSync(skill, 'utf-8');
			expect(text.startsWith('---\n')).toBe(true);
			expect(text).toContain('managed by @pattern-stack/codegen');
			expect(text).toContain('user-invocable: false');
		}
	});
});

describe('runSkillsInstall', () => {
	test('dry-run classifies created without writing to disk', () => {
		const cwd = mkTemp();
		const result = runSkillsInstall({ cwd, dryRun: true });
		expect(result.ok).toBe(true);
		expect(result.report!.created.length).toBeGreaterThan(0);
		expect(fs.existsSync(skillsTargetDir(cwd))).toBe(false);
	});

	test('real install vendors into .claude/skills; re-run is all unchanged', () => {
		const cwd = mkTemp();
		const first = runSkillsInstall({ cwd, dryRun: false });
		expect(first.report!.created.length).toBeGreaterThan(0);
		expect(fs.existsSync(path.join(skillsTargetDir(cwd), 'codegen', 'SKILL.md'))).toBe(true);

		const second = runSkillsInstall({ cwd, dryRun: false });
		expect(second.report!.created.length).toBe(0);
		expect(second.report!.updated.length).toBe(0);
		expect(second.report!.unchanged.length).toBe(first.report!.created.length);
	});

	test('a locally-edited skill is re-flagged as updated and refreshed', () => {
		const cwd = mkTemp();
		runSkillsInstall({ cwd, dryRun: false });
		const target = path.join(skillsTargetDir(cwd), 'codegen', 'SKILL.md');
		fs.writeFileSync(target, 'LOCAL EDIT\n');
		const report = runSkillsInstall({ cwd, dryRun: false }).report!;
		expect(report.updated.some((e) => e.relPath.endsWith('codegen/SKILL.md'))).toBe(true);
		expect(fs.readFileSync(target, 'utf-8')).toContain('managed by @pattern-stack/codegen');
	});
});
