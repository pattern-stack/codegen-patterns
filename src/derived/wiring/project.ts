/**
 * The whole set's class graph (PW-1): every entity's and junction's classes, as one graph, ordered.
 *
 * CLI-only, like `src/derived/api/project.ts`: it reads the project's API context.
 */

import { deriveEntityApiSurface } from '../api/entity.js';
import { projectEntityApiInputs, type ProjectApiContext } from '../api/project.js';
import { junctionIdentity } from '../../emitters/relations/build-graph.js';
import { entityClassGraph, junctionClassGraph, mergeClassGraphs } from './classes.js';
import { contextCycles, orderClasses } from './order.js';
import type { ClassGraph, ClassNode } from './types.js';

export interface ProjectClassGraph {
	graph: ClassGraph;
	/** Every class, each after the classes it takes. */
	order: ClassNode[];
	/** The cycles between contexts (`contextCycles`); empty when contexts form a DAG. */
	contextCycles: string[][];
}

/** Throws `ClassCycleError` on a class cycle. */
export function deriveProjectClassGraph(relations: ProjectApiContext['relations']): ProjectClassGraph {
	const inputs = projectEntityApiInputs(relations);
	const graph = mergeClassGraphs([
		...inputs.map((input) => entityClassGraph(input, deriveEntityApiSurface(input))),
		...relations.junctions
			.filter((j) => j.between.length === 2)
			.map((j) => junctionClassGraph({ name: junctionIdentity(j).name, left: j.between[0] ?? '', right: j.between[1] ?? '' })),
	]);
	const contexts = new Map(inputs.map((i) => [i.definition.entity.name, i.definition.entity.context ?? undefined]));
	return {
		graph,
		order: orderClasses(graph),
		contextCycles: contextCycles(graph, (owner) => contexts.get(owner)),
	};
}
