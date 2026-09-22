/**
 * Path safety for the Studio server (STUDIO-0, #698).
 *
 * Every filesystem path the HTTP surface touches comes from the client, so
 * exactly one function turns a client-supplied path into an absolute one, and
 * it refuses anything that leaves the project directory. Three escapes are
 * rejected, not two: an absolute path, a `..` traversal, and a symlink whose
 * target lies outside the project (the one a pure-string check misses).
 *
 * The symlink check resolves the nearest EXISTING ancestor of the target, so a
 * write to a not-yet-created file inside a symlinked directory is still
 * checked against where that directory really is.
 */

import fs from 'node:fs';
import path from 'node:path';

export class PathSafetyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PathSafetyError';
	}
}

/** `projectDir` with every symlink resolved — the root every path is checked against. */
export function realProjectDir(projectDir: string): string {
	const abs = path.resolve(projectDir);
	try {
		return fs.realpathSync(abs);
	} catch {
		// The project dir itself does not exist; callers surface that separately.
		return abs;
	}
}

/** True when `child` is `root` or lies beneath it. Both must already be absolute. */
function isInside(root: string, child: string): boolean {
	if (child === root) return true;
	return child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** The nearest ancestor of `abs` that exists on disk (possibly `abs` itself). */
function nearestExisting(abs: string): string {
	let current = abs;
	while (!fs.existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) return current;
		current = parent;
	}
	return current;
}

/**
 * Resolve a project-relative path to an absolute one inside `projectDir`.
 *
 * @throws {PathSafetyError} if the path is absolute, traverses out with `..`,
 *   or resolves through a symlink to somewhere outside the project.
 */
export function resolveProjectPath(projectDir: string, relPath: string): string {
	if (typeof relPath !== 'string' || relPath.length === 0) {
		throw new PathSafetyError('path is required');
	}
	if (relPath.includes('\0')) {
		throw new PathSafetyError('path contains a null byte');
	}
	if (path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
		throw new PathSafetyError(`absolute paths are not allowed: ${relPath}`);
	}

	const root = realProjectDir(projectDir);
	const abs = path.resolve(root, relPath);

	// String-level containment: catches `..` and `./../..` before touching disk.
	if (!isInside(root, abs)) {
		throw new PathSafetyError(`path escapes the project directory: ${relPath}`);
	}

	// Symlink-level containment: the escape a string check cannot see. Resolve
	// the deepest existing ancestor and re-check, then re-append the tail.
	const existing = nearestExisting(abs);
	let realExisting: string;
	try {
		realExisting = fs.realpathSync(existing);
	} catch {
		throw new PathSafetyError(`path could not be resolved: ${relPath}`);
	}
	if (!isInside(root, realExisting)) {
		throw new PathSafetyError(`path resolves outside the project directory: ${relPath}`);
	}

	const tail = path.relative(existing, abs);
	return tail === '' ? realExisting : path.join(realExisting, tail);
}

/** POSIX-separated path of `abs` relative to `projectDir` — the wire spelling. */
export function toProjectRelative(projectDir: string, abs: string): string {
	return path.relative(realProjectDir(projectDir), abs).split(path.sep).join('/');
}
