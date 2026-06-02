/**
 * Package-mode "installed" resolution + subsystems.install editing (ADR-037).
 *
 * Symptom #1 root cause: "installed" must be driven by `subsystems.install`,
 * not by vendored-file presence, in package mode.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';

import {
	configuredSubsystemNames,
	configuredInstalledSubsystems,
} from '../../cli/shared/subsystem-detect.js';
import {
	ensureSubsystemInstalled,
	readInstallList,
} from '../../cli/shared/subsystems-install-config.js';

const tempDirs: string[] = [];
afterEach(() => {
	for (const d of tempDirs) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {}
	}
	tempDirs.length = 0;
});

function tmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-detect-'));
	tempDirs.push(dir);
	return dir;
}

describe('configuredSubsystemNames', () => {
	test('reads subsystems.install, filters to known names, dedupes', () => {
		const names = configuredSubsystemNames({
			subsystems: { install: ['events', 'jobs', 'events', 'bogus', 'bridge'] },
		});
		expect(names).toEqual(['events', 'jobs', 'bridge']);
	});

	test('absent block → empty', () => {
		expect(configuredSubsystemNames({})).toEqual([]);
		expect(configuredSubsystemNames(null)).toEqual([]);
		expect(configuredSubsystemNames({ subsystems: {} })).toEqual([]);
	});
});

describe('configuredInstalledSubsystems', () => {
	test('synthesizes an installed set (always status=installed) with per-subsystem backend', () => {
		const installed = configuredInstalledSubsystems({
			subsystems: { install: ['events', 'jobs'] },
			jobs: { backend: 'memory' },
		});
		expect(installed.map((i) => i.name)).toEqual(['events', 'jobs']);
		expect(installed.every((i) => i.status === 'installed')).toBe(true);
		// events has no config block → default backend (drizzle).
		expect(installed.find((i) => i.name === 'events')?.backend).toBe('drizzle');
		// jobs.backend honored.
		expect(installed.find((i) => i.name === 'jobs')?.backend).toBe('memory');
	});
});

describe('ensureSubsystemInstalled', () => {
	test('creates the block when no config file exists', () => {
		const dir = tmp();
		const cfg = path.join(dir, 'codegen.config.yaml');
		const res = ensureSubsystemInstalled(cfg, 'events');
		expect(res.outcome).toBe('added');
		expect(res.install).toEqual(['events']);
		const parsed = readInstallList(
			yaml.parse(
				fs.readFileSync(cfg, 'utf-8'),
			),
		);
		expect(parsed).toEqual(['events']);
	});

	test('appends to an existing install list, preserving surrounding content', () => {
		const dir = tmp();
		const cfg = path.join(dir, 'codegen.config.yaml');
		fs.writeFileSync(
			cfg,
			'# my project\nruntime: package\nsubsystems:\n  install:\n    - events\nevents:\n  backend: drizzle\n',
		);
		const res = ensureSubsystemInstalled(cfg, 'jobs');
		expect(res.outcome).toBe('added');
		expect(res.install).toEqual(['events', 'jobs']);
		const after = fs.readFileSync(cfg, 'utf-8');
		// Surrounding content untouched.
		expect(after).toContain('# my project');
		expect(after).toContain('runtime: package');
		expect(after).toContain('events:\n  backend: drizzle');
		// Both items present.
		expect(after).toContain('- events');
		expect(after).toContain('- jobs');
	});

	test('idempotent — a name already present is a no-op', () => {
		const dir = tmp();
		const cfg = path.join(dir, 'codegen.config.yaml');
		fs.writeFileSync(cfg, 'subsystems:\n  install:\n    - events\n');
		const before = fs.readFileSync(cfg, 'utf-8');
		const res = ensureSubsystemInstalled(cfg, 'events');
		expect(res.outcome).toBe('already');
		expect(fs.readFileSync(cfg, 'utf-8')).toBe(before);
	});

	test('adds an install: block when subsystems: exists without one', () => {
		const dir = tmp();
		const cfg = path.join(dir, 'codegen.config.yaml');
		fs.writeFileSync(cfg, 'runtime: package\nsubsystems: {}\n');
		const res = ensureSubsystemInstalled(cfg, 'bridge');
		expect(res.outcome).toBe('added');
		expect(readInstallList(
			yaml.parse(
				fs.readFileSync(cfg, 'utf-8'),
			),
		)).toEqual(['bridge']);
	});

	test('parse-error YAML → parse-error outcome, file untouched', () => {
		const dir = tmp();
		const cfg = path.join(dir, 'codegen.config.yaml');
		fs.writeFileSync(cfg, 'subsystems:\n  install: "unterminated\n');
		const before = fs.readFileSync(cfg, 'utf-8');
		const res = ensureSubsystemInstalled(cfg, 'events');
		expect(res.outcome).toBe('parse-error');
		expect(fs.readFileSync(cfg, 'utf-8')).toBe(before);
	});
});
