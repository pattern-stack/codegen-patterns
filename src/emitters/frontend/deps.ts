/**
 * Frontend emitter — version-pairing contract (ADR-038, FE-2).
 *
 * The emitter emits imports against these package ranges; the generated app's
 * frontend `package.json` must install them. `@pattern-stack/codegen` itself
 * gains no runtime dependency — this constant is the single source of truth for
 * the pairing, surfaced into `generated/index.ts` (FE-3) so drift is visible in
 * the consumer.
 *
 * See docs/specs/2026-06-04-frontend-pipeline-rebuild.md → "Version pairing".
 */

export const FRONTEND_EMITTED_DEPS = {
	'@pattern-stack/frontend-patterns': '^0.2.0-alpha.18',
	'@tanstack/react-db': '^0.1.55',
	'@tanstack/electric-db-collection': '^0.2.11',
	'@tanstack/query-db-collection': '^1.0.6',
	'@tanstack/react-query': '^5.0.0',
} as const;

export type FrontendEmittedDeps = typeof FRONTEND_EMITTED_DEPS;
