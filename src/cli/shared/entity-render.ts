/**
 * The per-target half of `entity new` — its pre-flight and its hygen loop —
 * shared with `junction new`, which re-renders a junction's two parents through
 * exactly this path (JUNC-0, #678): a parent's service + module carry the
 * junction fan-out, rendered by the parent's own templates, so `junction new`
 * regenerates the parents rather than injecting into them. One render path for
 * an entity, whichever command asks for it.
 *
 * `entity new` = `preflightEntityTargets` + `renderEntityTargets` + its
 * whole-set post-steps (barrels, events, bridge, orchestration, frontend,
 * providers, jobs). `junction new` runs no post-step: none reads the junction
 * set, so the per-entity files it writes are exactly `entity new`'s.
 */

import fs from 'node:fs';

import { loadEntityFromYaml, loadEntitiesFromYaml } from '../../utils/yaml-loader.js';
import { junctionsDirFor } from '../../config/junctions-dir.js';
import { junctionSetIssues, loadJunctionSet } from '../../parser/load-junctions.js';
import { validateRolesForGeneration } from '../../roles/validate-roles.js';
import { loadAppPatternsForCli, patternLoadRejections } from './pattern-globs.js';
import type { Context } from './context.js';
import { invokeEntityNew } from './hygen.js';
import { collectMergedEvents } from './event-codegen-generator.js';
import { validateEntityEmits } from '../../parser/validate-emits.js';
import {
	loadProviderSet,
	resolveTsconfigAliases,
	collectEntitySurfaces,
} from './provider-module-generator.js';
import { loadEntities } from '../../parser/load-entities.js';
import { findYamlFiles } from '../../utils/find-yaml-files.js';
import type { AnalysisIssue } from '../../analyzer/types.js';
import { projectLayout } from './project-layout.js';
import { loadJobs } from '../../parser/load-jobs.js';
import { jobLoadRejections } from './emit-jobs.js';
import { issueRejections, type RejectionEntry, type RunRejection } from './run-rejections.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/output.js';
import { isJsonMode } from '../ui/json.js';

/**
 * List entity YAML files under `dir`, excluding the provider-definitions
 * subtree. When the entities dir IS the `definitions` root, the recursive walk
 * would otherwise pull in `definitions/providers/*.yaml`; passing the providers
 * dir as an exclusion keeps entity discovery to entity files only.
 */
export function listEntityYamls(dir: string, providersDir?: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return findYamlFiles(dir, {
		excludeDirs: providersDir ? [providersDir] : [],
	});
}

export interface EntityTarget {
	file: string;
	name: string;
}

export interface EntityPreflight {
	/** Targets that passed every per-target check — hygen renders these. */
	validated: EntityTarget[];
	/** Per-target rejections (schema, `emits:`, `roles:`). */
	invalid: RunRejection[];
	/** Run-level rejections: the run stops before hygen whatever `--continue-on-error` says. */
	runRejections: RunRejection[];
	emitsErrors: AnalysisIssue[];
	emitsWarnings: AnalysisIssue[];
	/** Loaded once here; `entity new`'s post-steps emit from them. */
	jobLoad: ReturnType<typeof loadJobs>;
	providerSet: ReturnType<typeof loadProviderSet>;
	tsAliases: ReturnType<typeof resolveTsconfigAliases>;
}

/** Every check `entity new` runs before hygen, for `targets` (absolute YAML paths). */
export async function preflightEntityTargets(
	ctx: Context,
	targets: string[],
): Promise<EntityPreflight> {
	// Pre-flight. Three checks can reject a target before hygen runs: the
	// schema (per file), the EVT-7 `emits:` cross-check against the merged
	// event registry, and the CAP-2 `roles:` cross-check. The last two are
	// cross-entity — an emitted event or a role's target lives in another
	// YAML — so neither the schema nor the one-entity hygen prompt can run
	// them. Every rejection keeps its per-issue details (the same diagnostics
	// `entity validate` prints) and is reported in every mode (#627):
	// `--continue-on-error` decides whether the run stops, never whether the
	// reason is shown.
	const validated: Array<{ file: string; name: string }> = [];
	const invalid: Array<{ file: string; message: string; details?: string[] }> =
		[];
	for (const file of targets) {
		const result = loadEntityFromYaml(file);
		if (result.success) {
			validated.push({ file, name: result.definition.entity.name });
		} else {
			invalid.push({ file, message: result.error, details: result.details });
		}
	}

	const entitiesDirForEmits = projectLayout(ctx.cwd, ctx.config).entities;
	const eventsDirForEmits = projectLayout(ctx.cwd, ctx.config).eventsDir;
	const allEntitiesForEmits = loadEntities(entitiesDirForEmits, {
		excludeDirs: [projectLayout(ctx.cwd, ctx.config).providers],
	}).entities;
	const validatedNames = new Set(validated.map((v) => v.name));
	const emitsTargetEntities = allEntitiesForEmits.filter((e) =>
		validatedNames.has(e.name),
	);
	const mergedEventsForEmits = collectMergedEvents({
		entitiesDir: entitiesDirForEmits,
		eventsDir: eventsDirForEmits,
	});
	const emitsIssues: AnalysisIssue[] = validateEntityEmits(
		emitsTargetEntities,
		mergedEventsForEmits.events,
	);
	const emitsErrors = emitsIssues.filter((i) => i.severity === 'error');
	const emitsWarnings = emitsIssues.filter(
		(i) => i.severity === 'warning',
	);

	for (const w of emitsWarnings) {
		printWarning(w.message);
	}
	const noEmitsCount = emitsWarnings.filter(
		(w) => w.type === 'no_emits',
	).length;
	if (noEmitsCount > 0) {
		printInfo(`${noEmitsCount} entities missing emits:`);
	}

	// Run-level rejections (JOBS-2): an input every entity's output depends
	// on, so it is not one target's problem and `--continue-on-error` does not
	// apply — the run stops before hygen whatever the flag says.
	const runRejections: RunRejection[] = [];

	// App patterns must be in THIS process's registry before the roles
	// pre-flight: a role's target qualifies by declaring an `Actor`
	// capability, which an app may define (and must, until the library ships
	// one). The hygen subprocess loads them for itself; this is the CLI's copy.
	// A file the loader could not register leaves a partial pattern set: the
	// orchestration step would rewrite its root barrel without that module,
	// and a role or `patterns:` entry naming it would resolve against the
	// wrong registry (#664, from the #660 audit).
	runRejections.push(...patternLoadRejections(await loadAppPatternsForCli(ctx), ctx.cwd));

	// Job definitions (RFC-0005 #7) — loaded ONCE, here, so their derived
	// artifacts feed the event + bridge codegen in the SAME pass: each
	// `schedule` arm desugars to a job-private scheduled event merged into the
	// event registry, and every trigger becomes a declarative bridge mapping.
	// The handler files themselves are emitted later (post-assembly). Opt-in:
	// no `definitions/jobs/` ⇒ empty. An invalid job YAML is a run-level
	// rejection (#664): its handler base, scheduled events and bridge triggers
	// feed registries every entity imports, and a previously emitted
	// `<type>.job.generated.ts` would outlive its dropped registrations.
	const { jobsDir, jobHandlers } = projectLayout(ctx.cwd, ctx.config);
	const jobLoad = loadJobs(jobsDir);
	runRejections.push(...jobLoadRejections(jobLoad.issues, jobHandlers));

	// Provider definitions (RFC-0001, Track D) — loaded and cross-validated
	// ONCE, here; the post-step emits from this set. A blocking issue (a YAML
	// that does not load, an unknown surface, a duplicate slug, an
	// unresolvable auth / client import) is a run-level rejection (#666): a
	// provider's module is imported by its surface's adapters module, its
	// change sources feed the surface registry, and its assembly modules are
	// imported by every integrated entity's integration wiring — skipping it
	// would regenerate the entities beside a stale integration layer. The
	// D1 import pre-flight resolves `@app/…#Export` against the consumer
	// tsconfig; with no tsconfig it is skipped (slug / surface checks still run).
	const { providers: providersDir } = projectLayout(ctx.cwd, ctx.config);
	const tsAliases = resolveTsconfigAliases(ctx.cwd);
	const providerSet = loadProviderSet({
		providersDir,
		entitySurfaces: collectEntitySurfaces(
			loadEntitiesFromYaml(listEntityYamls(entitiesDirForEmits, providersDir)).successes.map(
				(s) => s.definition,
			),
		),
		sourceRoot: tsAliases?.sourceRoot,
		aliases: tsAliases?.aliases,
		skipImportCheck: tsAliases === null,
	});
	runRejections.push(...issueRejections(providerSet.issues));

	// The junction set (JUNC-0, #678) — loaded ONCE, here. Every junction is
	// mirrored onto both parents' service + module, which their own templates
	// render from the junction YAMLs, so a junction is an input to two
	// entities' output: a junction file that fails the schema, or names an
	// entity with no YAML, is a run-level rejection (the #666 posture) — never
	// skipped, which would silently drop its fan-out.
	const junctionSet = loadJunctionSet(junctionsDirFor(ctx.cwd));
	runRejections.push(
		...junctionSetIssues(junctionSet, new Set(allEntitiesForEmits.map((e) => e.name))),
	);

	// Reuses the entity set the emits pre-flight already loaded. A bad role is
	// a generation-time error (the ADR-041 §4 posture).
	const roleErrors = validateRolesForGeneration({
		targets: emitsTargetEntities,
		entities: allEntitiesForEmits,
		junctions: junctionSet.junctions,
	});

	// An entity with an `emits:` or `roles:` error is not generated: the
	// hygen prompt assumes both blocks are valid.
	for (let i = validated.length - 1; i >= 0; i--) {
		const v = validated[i]!;
		const ownEmits = emitsErrors.filter((e) => e.entity === v.name);
		const ownRoles = roleErrors.filter((e) => e.entity === v.name);
		if (ownEmits.length === 0 && ownRoles.length === 0) continue;
		const blocks = [
			...(ownEmits.length > 0 ? ['emits:'] : []),
			...(ownRoles.length > 0 ? ['roles:'] : []),
		];
		invalid.push({
			file: v.file,
			message: `${blocks.join(' and ')} validation failed`,
			details: [...ownEmits, ...ownRoles].map((e) => e.message),
		});
		validated.splice(i, 1);
	}

	return {
		validated,
		invalid,
		runRejections,
		emitsErrors,
		emitsWarnings,
		jobLoad,
		providerSet,
		tsAliases,
	};
}

/**
 * Render each validated target through hygen (`entity new`). Stops at the first
 * failure unless `continueOnError`.
 */
export function renderEntityTargets(
	ctx: Context,
	validated: EntityTarget[],
	opts: { continueOnError: boolean },
): { succeeded: string[]; failed: RejectionEntry[] } {
	const succeeded: string[] = [];
	const failed: RejectionEntry[] = [];
	for (const v of validated) {
		if (!isJsonMode()) {
			printInfo(`generating ${v.name}`);
		}
		const res = invokeEntityNew(v.file, ctx.cwd, ctx.configPath);
		if (res.ok) {
			succeeded.push(v.name);
			if (!isJsonMode()) printSuccess(`${v.name}`);
		} else {
			failed.push({
				name: v.name,
				file: v.file,
				message: res.stderr ?? 'Hygen invocation failed',
				details: [],
			});
			if (!isJsonMode()) printError(`${v.name} — ${res.stderr ?? 'failed'}`);
			if (!opts.continueOnError) break;
		}
	}
	return { succeeded, failed };
}
