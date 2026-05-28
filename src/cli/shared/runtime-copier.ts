/**
 * runtime-copier — copy a runtime/ subdirectory into a user's project.
 *
 * Used by the subsystem noun to install {events, jobs, cache, storage} from
 * the shipped `runtime/subsystems/<name>/` into the user's project. Honors
 * file filters (for backend selection) and optionally walks the import graph
 * to also copy referenced runtime/types/ and runtime/constants/ files.
 *
 * The runtime tree is treated as read-only source of truth; this module only
 * reads from it and writes into the user's target.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface RuntimeCopyOptions {
	sourceDir: string;
	targetDir: string;
	filter?: (file: string) => boolean;
	resolveDeps?: boolean;
	/** runtime/ root (parent of subsystems/, types/, constants/). */
	runtimeRoot?: string;
	/** Where dependency files like runtime/types/foo.ts should land in the user project.
	 * Defaults to the parent directory of targetDir. */
	depsTargetRoot?: string;
	dryRun?: boolean;
	/**
	 * Refresh-only mode: skip any file whose destination does not already
	 * exist (and don't follow its imports). Used by `codegen update`, which
	 * re-syncs files that are already installed but must NOT install new ones
	 * — adding files is `subsystem install`'s job. Without this, a project that
	 * only vendored a subsystem's protocol (e.g. the events protocol at
	 * `project init`) would have its whole subsystem materialised by `update`.
	 */
	onlyExisting?: boolean;
}

export interface RuntimeCopyResult {
	written: string[];
	updated: string[];
	unchanged: string[];
	dependenciesCopied: string[];
	planned: string[];
}

function readIfExists(p: string): string | null {
	try {
		return fs.readFileSync(p, 'utf-8');
	} catch {
		return null;
	}
}

/**
 * Extract relative import paths from a TypeScript source file. Returns the
 * raw specifiers (e.g. '../../types/drizzle').
 */
function extractRelativeImports(source: string): string[] {
	const out: string[] = [];
	const re =
		/(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"`](\.{1,2}\/[^'"`]+)['"`]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source)) !== null) {
		out.push(m[1]);
	}
	return out;
}

function resolveSourceImport(
	sourceFile: string,
	specifier: string
): string | null {
	const base = path.resolve(path.dirname(sourceFile), specifier);
	const candidates = [base + '.ts', base + '.tsx', path.join(base, 'index.ts')];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	return null;
}

/**
 * Copy `sourceDir` into `targetDir`. Optionally follows relative imports and
 * copies referenced runtime/types/* and runtime/constants/* into a sibling
 * directory structure of targetDir.
 */
export async function copyRuntime(opts: RuntimeCopyOptions): Promise<RuntimeCopyResult> {
	const { sourceDir, targetDir, filter, resolveDeps, dryRun, onlyExisting } = opts;

	if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
		throw new Error(`runtime source directory not found: ${sourceDir}`);
	}

	const runtimeRoot = opts.runtimeRoot
		? path.resolve(opts.runtimeRoot)
		: path.resolve(sourceDir, '..', '..'); // runtime/subsystems/<x> → runtime/
	const depsTargetRoot = opts.depsTargetRoot ?? path.resolve(targetDir, '..');

	const result: RuntimeCopyResult = {
		written: [],
		updated: [],
		unchanged: [],
		dependenciesCopied: [],
		planned: [],
	};

	// Queue of source paths to copy; value is the destination path.
	const queue: Array<{ src: string; dest: string; isDep: boolean }> = [];

	// Enumerate files in sourceDir, recursing into subdirectories so nested
	// runtime layouts (e.g. observability/reporters/, auth/backends/oauth-*)
	// reach the user project intact. Preserves the relative path under
	// sourceDir when computing the destination.
	//
	// Skips `generated/` directories by convention — those are produced by
	// post-install codegen steps (event codegen, scope-entity-type, etc.)
	// and must not be shipped as static snapshots from the runtime source.
	function walk(dir: string): void {
		for (const entry of fs.readdirSync(dir)) {
			const src = path.join(dir, entry);
			const stat = fs.statSync(src);
			if (stat.isDirectory()) {
				if (entry === 'generated') continue;
				walk(src);
				continue;
			}
			if (!stat.isFile()) continue;
			if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
			const rel = path.relative(sourceDir, src);
			// Filter sees the relative path from sourceDir so callers can
			// discriminate on subdirectory when needed; historically they
			// only passed bare filenames, so also support the basename.
			if (filter && !filter(rel) && !filter(entry)) continue;
			queue.push({ src, dest: path.join(targetDir, rel), isDep: false });
		}
	}
	walk(sourceDir);

	const visited = new Set<string>();

	while (queue.length > 0) {
		const next = queue.shift()!;
		if (visited.has(next.src)) continue;
		visited.add(next.src);

		// Refresh-only mode (codegen update): never materialise a file that
		// isn't already installed, and don't follow its imports.
		if (onlyExisting && !fs.existsSync(next.dest)) {
			continue;
		}

		const content = fs.readFileSync(next.src, 'utf-8');
		result.planned.push(next.dest);

		// Classify against the current on-disk content. Done in both real and
		// dry-run modes so previews report accurate created/updated/unchanged
		// counts; the actual write is gated on `!dryRun`.
		const existing = readIfExists(next.dest);
		const status: 'written' | 'updated' | 'unchanged' =
			existing === content ? 'unchanged' : existing === null ? 'written' : 'updated';
		if (status === 'written') result.written.push(next.dest);
		else if (status === 'updated') result.updated.push(next.dest);
		else result.unchanged.push(next.dest);
		if (next.isDep) result.dependenciesCopied.push(next.dest);

		if (!dryRun && status !== 'unchanged') {
			fs.mkdirSync(path.dirname(next.dest), { recursive: true });
			fs.writeFileSync(next.dest, content);
		}

		if (resolveDeps) {
			for (const spec of extractRelativeImports(content)) {
				const resolvedSrc = resolveSourceImport(next.src, spec);
				if (!resolvedSrc) continue;
				// Only follow imports that land inside runtimeRoot.
				const relToRuntime = path.relative(runtimeRoot, resolvedSrc);
				if (relToRuntime.startsWith('..') || path.isAbsolute(relToRuntime)) continue;
				// If already under sourceDir, it's local — copied by the main loop already.
				const relToSource = path.relative(sourceDir, resolvedSrc);
				if (!relToSource.startsWith('..') && !path.isAbsolute(relToSource)) continue;

				// Place it under depsTargetRoot at the same relative path from runtimeRoot
				// minus the leading 'subsystems/<name>' if the file lives elsewhere.
				// Simpler: preserve runtime's own relative structure under depsTargetRoot.
				const depDest = path.join(depsTargetRoot, relToRuntime);
				queue.push({ src: resolvedSrc, dest: depDest, isDep: true });
			}
		}
	}

	return result;
}
