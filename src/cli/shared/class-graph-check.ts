/**
 * The generation-time class-cycle check (PW-1): the whole set's class graph has no cycle, or the run stops before
 * hygen with the cycle named. Pattern-stack wiring constructs classes in dependency order, so a cycle is a real defect
 * even for a Nest project, whose `forwardRef` would hide it (the plan's decision: no class cycles).
 */
import { loadProjectApiContext } from '../../derived/api/project.js';
import { DuplicateClassError } from '../../derived/wiring/classes.js';
import { ClassCycleError } from '../../derived/wiring/order.js';
import { deriveProjectClassGraph } from '../../derived/wiring/project.js';
import type { RelationsConfigInput } from '../../emitters/relations/load-context.js';
import { junctionsDirFor, relationshipsDirFor } from '../../config/junctions-dir.js';
import type { RunRejection } from './run-rejections.js';

export function classGraphRejections(
	cwd: string,
	config: RelationsConfigInput | null | undefined,
	entitiesDir: string,
): RunRejection[] {
	// The set's loader errors are the pre-flight's to report (an invalid YAML is a target rejection, and a run with
	// `--continue-on-error` goes on without it); this check reads only the set that loads.
	let relations;
	try {
		relations = loadProjectApiContext(cwd, config, {
			entitiesDir,
			junctionsDir: junctionsDirFor(cwd),
			relationshipsDir: relationshipsDirFor(cwd),
		}).relations;
	} catch {
		return [];
	}
	try {
		deriveProjectClassGraph(relations);
		return [];
	} catch (err) {
		// A cycle and a class two owners emit are this check's to report (no other check names them). Anything else
		// here (a junction end or a composed entity with no YAML) has a cause another pre-flight check reports by name.
		if (err instanceof ClassCycleError) {
			return [{ file: null, message: err.message, details: ['generated classes must form a chain (no class cycles); see docs/specs/PW-1.md'] }];
		}
		if (err instanceof DuplicateClassError) {
			return [{ file: null, message: err.message, details: ['rename one of the two, or give the entity a different name'] }];
		}
		return [];
	}
}
