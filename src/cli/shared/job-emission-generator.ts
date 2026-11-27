/**
 * Jobs definition-kind emitter (RFC-0005, breakdown #7).
 *
 * Compiles a `JobDefinition` (definitions/jobs/*.yaml, validated by #5/#6) into:
 *
 *   1. A seam-split `@pattern-stack/jobs` job (JOBS-3) — mirroring `sink-emission-generator.ts`:
 *      - `<type>.job.generated.ts` — `@generated` (regenerated via writeIfChanged):
 *        the input schema, the per-arm `DetectionConfig` literals, the arms
 *        interface, and `define<Type>Job(arms)`: a `defineJob` keyed by the YAML
 *        type with one step per arm (the YAML pool as its limiter, the retry,
 *        collision and dedupe window reflowed from YAML).
 *      - `<type>.job.ts` — emit-once (existsSync-skip in the caller):
 *        `export const <type>Job = define<Type>Job({ … })`, the arm bodies the
 *        author fills.
 *   2. Bridge contributions (`buildJobBridgeTriggers`) — synthetic `ScannedTrigger`s
 *      fed DECLARATIVELY into the bridge registry generator's `extraTriggers` seam
 *      (RFC-0005 fork 1). The emitted job carries NO `jobTriggers`; the bridge
 *      mapping is contributed here with a generated `map` string, never round-
 *      tripped through the AST scan.
 *   3. Scheduled events (`buildJobScheduledEvents`) — one job-private domain event
 *      per `schedule` arm (RFC-0005 fork 2 / ADR-039), merged into the event
 *      registry like EMIT-CHANGES. Cadence is job-owned; the emitter generates the
 *      tick event the bridge then fires the job on.
 *
 * Provider/use-case resolution stays author-side (RFC-0005 OQ-4 b — provider is not
 * in the YAML); the per-arm `runArm*` seam is where the author wires the change
 * source (from the regenerated `<type>ArmDetection.<domain>`) into their provider's
 * `ExecuteIntegrationUseCase`.
 *
 * All functions here are PURE (return strings / data); path + write + emit-once
 * logic lives in the caller (#7b, the entity-new post-step).
 */

import { subsystemsImport, runtimeImport, type RuntimeMode } from "./runtime-import";
import type { ScannedTrigger } from "./bridge-registry-generator";
import {
	type EventDefinition,
	DIRECTION_TO_POOL,
} from "../../schema/event-definition.schema";
import {
	BACKOFF_COEFFICIENT,
	DEFAULT_JOB_LIMITS,
	type JobDefinition,
	type JobArm,
	type JobTriggerDef,
} from "../../schema/job-definition.schema";

// ============================================================================
// Names
// ============================================================================

/** snake_case → PascalCase (`drive_poll` → `DrivePoll`). */
function pascalCase(snake: string): string {
	return snake
		.split("_")
		.filter(Boolean)
		.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
		.join("");
}

/** snake_case → camelCase (`drive_poll` → `drivePoll`). */
function camelCase(snake: string): string {
	const pascal = pascalCase(snake);
	return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

interface JobNames {
	jobConst: string; // drivePollJob
	defineFn: string; // defineDrivePollJob
	armsType: string; // DrivePollArms
	inputSchema: string; // drivePollInput
	armResultSchema: string; // drivePollArmResult
	detectionConst: string; // drivePollArmDetection
	inputType: string; // DrivePollInput
	armResultType: string; // DrivePollArmResult
	baseModule: string; // drive_poll.job.generated (extension-less)
}

function jobNames(jobType: string): JobNames {
	const Pascal = pascalCase(jobType);
	const camel = camelCase(jobType);
	return {
		jobConst: `${camel}Job`,
		defineFn: `define${Pascal}Job`,
		armsType: `${Pascal}Arms`,
		inputSchema: `${camel}Input`,
		armResultSchema: `${camel}ArmResult`,
		detectionConst: `${camel}ArmDetection`,
		inputType: `${Pascal}Input`,
		armResultType: `${Pascal}ArmResult`,
		baseModule: `${jobType}.job.generated`,
	};
}

// ============================================================================
// Input
// ============================================================================

/** Pure input for the job emitters. The caller derives this from the loaded
 *  `JobDefinition` + config; nothing here is path-computed inside the emitter. */
export interface JobEmitInput {
	/** The validated job definition (one `definitions/jobs/*.yaml`). */
	job: JobDefinition;
	/** Runtime mode (ADR-037) — selects the subsystem import specifier. Default `package`. */
	mode?: RuntimeMode;
}

// ============================================================================
// Scheduled-event naming (shared by the bridge + event contributions)
// ============================================================================

/** The schedule arms of a job, paired with their index in `triggers`. */
function scheduleArms(job: JobDefinition): Array<{ index: number; schedule: Extract<JobTriggerDef, { schedule: unknown }>["schedule"] }> {
	const out: Array<{ index: number; schedule: Extract<JobTriggerDef, { schedule: unknown }>["schedule"] }> = [];
	job.triggers.forEach((t, index) => {
		if ("schedule" in t) out.push({ index, schedule: t.schedule });
	});
	return out;
}

/**
 * The generated, job-private scheduled-event type for a schedule arm. One
 * schedule arm → `<job_type>__sched`; multiple → `<job_type>__sched__<index>`
 * (the trigger index, for stability). The `__sched` infix namespaces these away
 * from EMIT-CHANGES (`<entity>_<verb>`) and hand-authored events; snake_case-safe.
 */
function scheduledEventType(jobType: string, triggerIndex: number, totalScheduleArms: number): string {
	return totalScheduleArms <= 1 ? `${jobType}__sched` : `${jobType}__sched__${triggerIndex}`;
}

// ============================================================================
// Bridge contribution — declarative ScannedTriggers (fork 1)
// ============================================================================

/**
 * Build the synthetic `ScannedTrigger`s for one or more jobs, to feed the bridge
 * registry generator's `extraTriggers` seam. Each trigger (schedule or event arm)
 * becomes one job→event bridge mapping with a GENERATED `map` string — never a
 * round-tripped author arrow. The bridge generator validates these (unknown-event,
 * duplicate, audit) alongside the AST-scanned hand-authored triggers.
 *
 * `sourceFile` is the job YAML path (for the generator's error citations).
 */
export function buildJobBridgeTriggers(job: JobDefinition, sourceFile: string): ScannedTrigger[] {
	const total = scheduleArms(job).length;
	return job.triggers.map((trigger, index) => {
		const event =
			"schedule" in trigger
				? scheduledEventType(job.type, index, total)
				: trigger.event;
		return {
			jobKey: job.type,
			triggerId: `${job.type}#${index}`,
			event,
			// Generated map: a sync job's start payload is uniform/minimal (RFC-0005
			// fork 3). The bridge inlines this verbatim; keep it self-contained.
			mapSource: "() => ({})",
			// A job that declares `collision` or `dedupe` (RFC-0005 / JOBS-3): every start of it shares one dedupe key per
			// tenant, so a tick while the last run is open meets the collision (overrun protection, ADR-022's
			// `concurrency.key`) and the dedupe window. Without either, starts never collide.
			...(job.collision !== undefined || job.dedupe !== undefined
				? { dedupeKeySource: `() => ${JSON.stringify(job.type)}` }
				: {}),
			sourceFile,
			sourceLine: index + 1,
		};
	});
}

// ============================================================================
// Scheduled-event contribution — one domain event per schedule arm (fork 2)
// ============================================================================

/**
 * Build the job-private scheduled `EventDefinition`s for a job (one per schedule
 * arm). Each is a `tier: domain`, `direction: inbound` event carrying the arm's
 * `schedule:` block — bridge-eligible AND a valid `ScheduledEvent` (the
 * EventScheduler materialises a tick per slot; the bridge fires the job). Merge
 * these into the event registry via the sugar arm (top-level-wins), exactly like
 * EMIT-CHANGES.
 */
export function buildJobScheduledEvents(job: JobDefinition): EventDefinition[] {
	const arms = scheduleArms(job);
	return arms.map(({ index, schedule }) => ({
		type: scheduledEventType(job.type, index, arms.length),
		tier: "domain" as const,
		direction: "inbound" as const,
		// inbound needs no aggregate/source; a time tick has no entity aggregate.
		payload: {},
		retry: { attempts: 3, backoff: "exponential" as const },
		version: 1,
		pool: DIRECTION_TO_POOL.inbound,
		schedule,
		description: `Job-private cadence tick for '${job.type}' (RFC-0005 schedule arm). Generated — do not author.`,
	}));
}

// ============================================================================
// Job facts — the defineJob options reflowed from YAML (JOBS-3)
// ============================================================================

/** The YAML retry as `@pattern-stack/jobs`' `RetryPolicy` (attempts in all; a fixed backoff is coefficient 1). */
function renderRetry(job: JobDefinition): string | null {
	const r = job.retry;
	if (!r) return null;
	const nonRetryable = r.nonRetryableErrors ? `, nonRetryableErrorTypes: ${JSON.stringify(r.nonRetryableErrors)}` : "";
	return `{ maximumAttempts: ${Math.max(1, r.attempts)}, initialIntervalMs: ${r.baseMs}, backoffCoefficient: ${BACKOFF_COEFFICIENT[r.backoff]}${nonRetryable} }`;
}

/** The job-level options: its limits, the collision rule and the dedupe window. */
function buildJobFactLines(job: JobDefinition): string[] {
	const lines: string[] = [];
	// Always: a bridge or schedule start names no budget, and a job with no limits refuses such a start.
	const limits = { ...DEFAULT_JOB_LIMITS, ...(job.limits ?? {}) };
	lines.push(
		`    limits: { maxItems: ${limits.maxItems}, maxUsd: ${limits.maxUsd}, maxCalls: ${limits.maxCalls}, maxDurationMs: ${limits.maxDurationMs} },`,
	);
	if (job.collision !== undefined) lines.push(`    collision: ${JSON.stringify(job.collision)},`);
	if (job.dedupe !== undefined) lines.push(`    dedupeWindowMs: ${job.dedupe.windowMs},`);
	return lines;
}

// ============================================================================
// Per-arm detection literals
// ============================================================================

function buildDetectionLines(job: JobDefinition): string[] {
	const lines: string[] = [];
	for (const arm of job.arms) {
		// The `read` block is a parsed DetectionConfig (plain data) — JSON is valid TS.
		const literal = JSON.stringify(arm.read, null, 2)
			.split("\n")
			.map((l, i) => (i === 0 ? l : `\t${l}`))
			.join("\n");
		lines.push(`\t${arm.domain}: ${literal} as DetectionConfig,`);
	}
	return lines;
}

/** Per-arm action for the integration run, derived from the arm kind (the schema
 *  cross-arm invariant guarantees realtime⇒webhook, poll/reconcile⇒poll). */
function armAction(arm: JobArm): "poll" | "webhook" {
	return arm.kind === "realtime" ? "webhook" : "poll";
}

// ============================================================================
// Emitters
// ============================================================================

/** Emit the `@generated` base file (`<type>.job.generated.ts`). */
export function generateJobHandlerBase(input: JobEmitInput): string {
	const { job } = input;
	const mode = input.mode ?? "package";
	const n = jobNames(job.type);
	// DetectionConfig is on the top `/subsystems` barrel.
	const integrationImport = subsystemsImport(mode, "integration");
	const detectionLines = buildDetectionLines(job);
	const retry = renderRetry(job);
	const stepOptions = [
		...(job.pool !== undefined ? [`limiter: ${JSON.stringify(job.pool)}`] : []),
		...(retry ? [`retry: ${retry}`] : []),
	];
	const stepLines = job.arms.map(
		(arm) =>
			`      .add(${JSON.stringify(arm.domain)}, step({ ${[...stepOptions, `run: (ctx) => arms.${arm.domain}(ctx)`].join(", ")} }))`,
	);
	const armKinds = Array.from(new Set(job.arms.map((a) => a.kind)))
		.map((k) => JSON.stringify(k))
		.join(" | ");
	const armSignatures = job.arms.map(
		(arm) =>
			`  /** Arm '${arm.domain}' (kind: ${arm.kind}, action: ${armAction(arm)}): build a change source from \`${n.detectionConst}.${arm.domain}\` and run your provider's ExecuteIntegrationUseCase with it (RFC-0005 OQ-4 b). */\n  ${arm.domain}: (ctx: ${n.inputType}Context) => Promise<${n.armResultType}>;`,
	);
	const banner =
		`// @generated by @pattern-stack/codegen from definitions/jobs/${job.type}.yaml — DO NOT EDIT.\n` +
		`// Hand edits are overwritten on re-emit. Regenerate with \`bun run codegen\`.\n` +
		`//\n` +
		`// Two-file seam (RFC-0005, JOBS-3):\n` +
		`//   THIS FILE  — @generated: the input, the per-arm detection, and ${n.defineFn}(arms), the job's\n` +
		`//                \`defineJob\` with one step per arm (its pool as the step's limiter).\n` +
		`//   ${job.type}.job.ts — emit-once: \`export const ${n.jobConst} = ${n.defineFn}({ … })\`, the\n` +
		`//                author's arm bodies. Author edits survive regen.\n` +
		`//\n` +
		`// Triggers are contributed to the bridge registry by the jobs emitter (RFC-0005 fork 1).`;
	return `${banner}
import { defineJob, step } from '@pattern-stack/jobs';
import { z } from 'zod';
import type { DetectionConfig } from '${integrationImport}';

/** The job's start-payload input: a sync job's start is uniform (RFC-0005 fork 3). */
export const ${n.inputSchema} = z.object({ provider: z.string().optional() });
export type ${n.inputType} = z.output<typeof ${n.inputSchema}>;

/** What an arm's body is handed: the run's input, its ids, and its abort signal. */
export interface ${n.inputType}Context {
  readonly input: ${n.inputType};
  readonly runId: string;
  readonly tenantId: string;
  readonly signal: AbortSignal;
}

/** Per-arm summary (one per arm, a step's output). Its arm kinds here: ${armKinds}. */
const ${n.armResultSchema} = z.object({ domain: z.string(), kind: z.string(), recordsProcessed: z.number() });
export type ${n.armResultType} = z.output<typeof ${n.armResultSchema}>;

/** Per-arm detection configs (the embedded \`read:\` leaf), reflowed from YAML. */
export const ${n.detectionConst} = {
${detectionLines.join("\n")}
};

/** The author's arm bodies, one per arm. */
export interface ${n.armsType} {
${armSignatures.join("\n")}
}

/** The job, for these arm bodies: one plain step per arm, in declaration order. */
export function ${n.defineFn}(arms: ${n.armsType}) {
  return defineJob({
    key: ${JSON.stringify(job.type)},
    input: ${n.inputSchema},
    // The last step's output is the job's: the last arm's summary.
    output: ${n.armResultSchema},
${buildJobFactLines(job).join("\n")}
    steps: (s) =>
      s
${stepLines.join("\n")},
  });
}
`;
}

/** Emit the emit-once author file (`<type>.job.ts`). */
export function generateJobHandlerSubclass(input: JobEmitInput): string {
	const { job } = input;
	const n = jobNames(job.type);
	const armImpls = job.arms
		.map((arm) =>
			[
				`      ${arm.domain}: async (_ctx) => {`,
				`        // TODO(author): build the change source from ${n.detectionConst}.${arm.domain} and run`,
				`        // your provider's ExecuteIntegrationUseCase (a dependency above) with it. See RFC-0005.`,
				`        throw new Error('${job.type}: arm ${arm.domain} is not implemented');`,
				`      },`,
			].join("\n"),
		)
		.join("\n");
	return `// Emit-once — author-owned. Regen never overwrites this file.
// The mechanical options + detection live in ${n.baseModule}.ts and reflow on every run.
// Source: definitions/jobs/${job.type}.yaml.
import { jobFactory } from '@pattern-stack/jobs';

import { ${n.detectionConst}, ${n.defineFn} } from './${n.baseModule}';

// Reference the regenerated detection so the import is live before the arms are filled.
void ${n.detectionConst};

/**
 * The job, as a factory of the app's services its arms need (JOBS-3). Name each in \`deps\` by its token: a class,
 * or \`injected<T>('<TOKEN>')\` (from '@pattern-stack/jobs') — for an arm's sync, the provider's integration use case,
 * \`injected<ExecuteIntegrationUseCase<…>>('<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>')\`. The app builds it with
 * them resolved; use them inside an arm, never while building the job.
 */
export const ${n.jobConst} = jobFactory({
  deps: {},
  create: (deps) => {
    void deps;
    return ${n.defineFn}({
${armImpls}
    });
  },
});
`;
}
