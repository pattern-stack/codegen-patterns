/**
 * `@pattern-stack/jobs/shapes`: the jobs API's wire shapes (job descriptions, runs, starts, the ops views, the input form), framework-free, so a
 * Nest layer, a Hono layer and a browser read the same definitions.
 */
export * from './shapes/index.ts';
export * from './shapes/ops.ts';
export { defineShape } from './shapes/define-shape.ts';
