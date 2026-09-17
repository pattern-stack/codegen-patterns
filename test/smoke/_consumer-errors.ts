/**
 * Shared tsc-output scoping for the smoke harnesses.
 *
 * ## Why this is not a filter
 *
 * A smoke harness generates a project into a tmp dir and runs
 * `tsc --noEmit --skipLibCheck` inside it. Its subject is **the code the
 * generator emitted**. `tsc` also reports diagnostics located in files the
 * generator did not write — dependencies under `node_modules/`, and (in
 * checkout mode) runtime sources reached by a relative path out of the tmp
 * dir. Dropping those is *scoping the gate to its subject*, keyed on the
 * diagnostic's **file location**.
 *
 * Every previous version of this function also dropped diagnostics by
 * matching the error **message**, which is a different and much worse thing:
 *
 *   - `line.includes('../')` dropped every `Cannot find module '../x'` in
 *     generated code, so a broken relative import could never fail a smoke
 *     (#576, closed by DRZ-2/#584);
 *   - `line.includes('node_modules/')` dropped duplicate-package type
 *     mismatches wherever they occurred;
 *   - a `.schema.ts` exclusion plus `Property 'table' … not assignable`,
 *     `Cannot assign an abstract constructor` and `Property 'findByX'`
 *     exclusions existed for the drizzle 0.30↔0.45 API mismatch, retired by
 *     the move to the 1.0 line (DRZ-2).
 *
 * Charter invariant I9 (gates are honest): there are no error-class
 * exclusions here, and none may be added. A residual error class that cannot
 * be fixed gets its own issue and a named, single-purpose expectation at the
 * call site — never a predicate in this function.
 */

/** `path/to/file.ts(12,5): error TS2307: …` — group 1 is the file location. */
const DIAGNOSTIC_RE = /^(.+?)\((\d+),(\d+)\): error TS\d+:/;

/**
 * Return the `tsc` diagnostics located in files the generator emitted.
 *
 * Kept: any diagnostic whose file location is inside the generated project.
 * Dropped: diagnostics located outside it (a `../` path out of the tmp dir)
 * or inside `node_modules/`. A diagnostic with **no** file location (a
 * whole-program or tsconfig error, e.g. TS18003 "no inputs were found") is
 * kept — it means the gate did not compile what it thought it was compiling.
 *
 * One returned entry = one diagnostic, so `.length` is the error count. Each
 * entry carries `tsc`'s indented elaboration lines (the "Type X is not
 * assignable to Y" chain under a TS2416) joined with newlines, because that
 * chain is usually the only part that says *why* — dropping it makes a red
 * gate unreadable without re-running `tsc` by hand.
 */
export function consumerErrors(output: string): string[] {
	const diagnostics: string[][] = [];
	// The diagnostic currently being accumulated, or null while inside one that
	// is being dropped (so its elaboration lines are dropped with it).
	let current: string[] | null = null;

	for (const line of output.split('\n')) {
		if (!line.trim()) continue;

		// An indented line elaborates the diagnostic above it.
		if (/^\s/.test(line)) {
			current?.push(line);
			continue;
		}

		current = null;
		if (!/error TS\d+:/.test(line)) continue;

		const located = DIAGNOSTIC_RE.exec(line);
		if (located) {
			const file = located[1];
			// `tsc` runs with cwd = the generated project, so its locations are
			// relative to it. A leading `../` means the file lives outside.
			if (file.startsWith('../') || file.startsWith('..\\')) continue;
			if (/(^|[/\\])node_modules[/\\]/.test(file)) continue;
		}
		// Either a located diagnostic inside the project, or an unlocated
		// whole-program / tsconfig diagnostic. Both are real.
		current = [line];
		diagnostics.push(current);
	}

	return diagnostics.map((lines) => lines.join('\n'));
}
