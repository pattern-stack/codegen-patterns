/**
 * App-defined capability patterns — CAP-1 smoke fixture (consumer-authored).
 *
 * `Actor` and `Communication` are LIBRARY capabilities (CAP-3); this project
 * cannot redeclare them — an app pattern reusing a library name is a load
 * error (ADR-041.1). What stays here is the app-capability path.
 *
 * Loaded by `loadAppPatterns()` from the default `src/patterns/*.pattern.ts`
 * glob. Every export whose name ends in `Pattern` and carries a `name` is
 * registered; `kind: 'capability'` routes it to ADR-041's layering path.
 *
 * Authored as plain objects on purpose: a consumer pattern file is imported by
 * the CLI *and* by the hygen subprocess, so it must resolve with nothing but
 * what the consumer project itself installs. `defineCapabilityPattern()` from
 * `@pattern-stack/codegen` is available to consumers who install the package;
 * this fixture runs in both runtime modes, so it takes neither dependency.
 */
import { z } from 'zod';

export const GroupPattern = {
	name: 'Group',
	kind: 'capability' as const,
	mixin: 'WithGroup',
	mixinImport: '@modules/capabilities/with-group',
	forwarderMethods: ['members'],
	configSchema: z.object({ membersColumn: z.string() }).strict(),
	description: 'Group membership — CAP-1 smoke fixture',
};

export const IndividualPattern = {
	name: 'Individual',
	kind: 'capability' as const,
	mixin: 'WithIndividual',
	mixinImport: '@modules/capabilities/with-individual',
	forwarderMethods: ['principal'],
	description: 'Single-actor lookup — CAP-1 smoke fixture',
};

export const AuditedPattern = {
	name: 'Audited',
	kind: 'capability' as const,
	mixin: 'WithAudited',
	mixinImport: '@modules/capabilities/with-audited',
	forwarderMethods: ['auditCount'],
	description: 'Audit counters — CAP-1 smoke fixture',
};

/** NEGATIVE fixture: contributes a method the `queries:` block also generates. */
export const CollidingPattern = {
	name: 'Colliding',
	kind: 'capability' as const,
	mixin: 'WithColliding',
	mixinImport: '@modules/capabilities/with-colliding',
	forwarderMethods: ['findByEmail'],
	description: 'Deliberate method collision — CAP-1 negative fixture',
};
