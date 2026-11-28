/**
 * The whole set's class graph (PW-1): every entity's and junction's classes, as one graph, ordered.
 *
 * CLI-only, like `src/derived/api/project.ts`: it reads the project's API context.
 */

import { deriveEntityApiSurface } from '../api/entity.js';
import { projectEntityApiInputs, type ProjectApiContext } from '../api/project.js';
import { junctionName } from '../../config/junction-naming.js';
import { entityClassGraph, junctionClassGraph, mergeClassGraphs } from './classes.js';
import { orderClasses } from './order.js';
import type { ClassGraph, ClassNode } from './types.js';

export interface ProjectClassGraph {
	graph: ClassGraph;
	/** Every class, each after the classes it takes. */
	order: ClassNode[];
}

/** Throws `ClassCycleError` on a class cycle. */
export function deriveProjectClassGraph(relations: ProjectApiContext['relations']): ProjectClassGraph {
	const inputs = projectEntityApiInputs(relations);
	const graph = mergeClassGraphs([
		...inputs.map((input) => entityClassGraph(input, deriveEntityApiSurface(input))),
		...relations.junctions
			.filter((j) => j.between.length === 2)
			.map((j) => {
				const [left = '', right = ''] = j.between;
				return junctionClassGraph({ name: junctionName([left, right]), left, right });
			}),
	]);
	return { graph, order: orderClasses(graph) };
}
