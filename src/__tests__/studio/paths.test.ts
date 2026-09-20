/**
 * Path-traversal rejection for the Studio file surface (STUDIO-0, #698).
 *
 * Every filesystem path the HTTP surface touches comes from the client, so
 * this is the test that decides whether `GET /api/files/..%2F..%2Fetc%2Fpasswd`
 * reads /etc/passwd. The symlink cases are the ones a string-only check
 * passes: a `..`-free, relative path that still leaves the project.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PathSafetyError, resolveProjectPath, toProjectRelative } from '../../studio/server/paths';

let root: string;
let projectDir: string;
let outsideDir: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-paths-'));
	projectDir = path.join(root, 'project');
	outsideDir = path.join(root, 'outside');
	fs.mkdirSync(path.join(projectDir, 'entities'), { recursive: true });
	fs.mkdirSync(outsideDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, 'entities', 'contact.yaml'), 'entity:\n  name: contact\n');
	fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'nope');
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveProjectPath — accepts paths inside the project', () => {
	it('resolves a nested relative path', () => {
		const abs = resolveProjectPath(projectDir, 'entities/contact.yaml');
		expect(abs).toBe(path.join(fs.realpathSync(projectDir), 'entities', 'contact.yaml'));
	});

	it('resolves a path to a file that does not exist yet (a create)', () => {
		const abs = resolveProjectPath(projectDir, 'relationships/contact_opportunity.yaml');
		expect(abs.startsWith(fs.realpathSync(projectDir))).toBe(true);
	});

	it('allows `..` that stays inside the project', () => {
		const abs = resolveProjectPath(projectDir, 'entities/../entities/contact.yaml');
		expect(abs).toBe(path.join(fs.realpathSync(projectDir), 'entities', 'contact.yaml'));
	});
});

describe('resolveProjectPath — rejects every escape', () => {
	it('rejects a `..` traversal', () => {
		expect(() => resolveProjectPath(projectDir, '../outside/secret.txt')).toThrow(PathSafetyError);
	});

	it('rejects a deep `..` traversal to an absolute-looking target', () => {
		expect(() => resolveProjectPath(projectDir, '../../../../../../etc/passwd')).toThrow(
			PathSafetyError,
		);
	});

	it('rejects a `..` hidden mid-path', () => {
		expect(() => resolveProjectPath(projectDir, 'entities/../../outside/secret.txt')).toThrow(
			PathSafetyError,
		);
	});

	it('rejects an absolute path', () => {
		expect(() => resolveProjectPath(projectDir, '/etc/passwd')).toThrow(PathSafetyError);
	});

	it('rejects a Windows-style absolute path', () => {
		expect(() => resolveProjectPath(projectDir, 'C:\\Windows\\system.ini')).toThrow(
			PathSafetyError,
		);
	});

	it('rejects an empty path', () => {
		expect(() => resolveProjectPath(projectDir, '')).toThrow(PathSafetyError);
	});

	it('rejects a null byte', () => {
		expect(() => resolveProjectPath(projectDir, 'entities/contact.yaml\0.png')).toThrow(
			PathSafetyError,
		);
	});

	it('rejects a SYMLINKED FILE pointing outside the project', () => {
		// No `..` anywhere in the request — a string check passes this.
		fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(projectDir, 'leak.yaml'));
		expect(() => resolveProjectPath(projectDir, 'leak.yaml')).toThrow(PathSafetyError);
	});

	it('rejects a path THROUGH a symlinked directory pointing outside', () => {
		fs.symlinkSync(outsideDir, path.join(projectDir, 'escape'));
		expect(() => resolveProjectPath(projectDir, 'escape/secret.txt')).toThrow(PathSafetyError);
	});

	it('rejects a NEW file under a symlinked directory pointing outside', () => {
		// The write case: the target does not exist, so only the ancestor can
		// be resolved — and it is the ancestor that escapes.
		expect(() => resolveProjectPath(projectDir, 'escape/planted.yaml')).toThrow(PathSafetyError);
	});
});

describe('toProjectRelative', () => {
	it('returns a POSIX path relative to the project', () => {
		const abs = path.join(fs.realpathSync(projectDir), 'entities', 'contact.yaml');
		expect(toProjectRelative(projectDir, abs)).toBe('entities/contact.yaml');
	});
});
