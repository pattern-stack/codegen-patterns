import { z } from "./zod";
import { DetectionConfigSchema as RuntimeDetectionConfigSchema } from "../../runtime/subsystems/integration";
import { ScheduleSchema } from "./event-definition.schema";

/** The runtime's detection schema (one owner), described for editors. */
const DetectionConfigSchema = RuntimeDetectionConfigSchema.describe(
	"The arm's read source, the same shape as an entity's 'detection:' entry: 'mode: poll' or 'mode: webhook', and 'mapping:'",
);

/**
 * Job Definition Schema — the codegen "jobs" definition kind (RFC-0005).
 *
 * Describes a single `definitions/jobs/*.yaml` file: a declarative sync-job
 * profile that the codegen jobs emitter compiles into a `@pattern-stack/jobs` job
 * (`define<Type>Job(arms)`, JOBS-3).
 * The load-bearing A→B contract (swe-brain ADR-0018): a per-adapter sync-profile
 * object IS a `JobDefinition`. swe-brain authors the YAML; codegen compiles it.
 *
 * Two discriminated unions at two altitudes (ADR-0018 D1+D3):
 *   - arm `kind`  (poll | reconcile | realtime) — the source-USAGE shape, here.
 *   - source `mode` (poll | webhook)            — the embedded `DetectionConfig`
 *     leaf, REUSED verbatim from `runtime/subsystems/integration` (ADR-033),
 *     never redefined.
 *
 * Codegen-side resolutions of the brief's §3 (recorded in RFC-0005):
 *   - The differ knob is named `differ.unignore` — NOT `dedupe.unignore` — so it
 *     does not collide with `dedupe` (the job's dedupe window, `{ windowMs }`).
 *     `differ.unignore` maps to `integration.differ.unignore`.
 *   - No `lane` field: the execution lane is `pool` (a `@pattern-stack/jobs`
 *     limiter, JOBS-3).
 *   - JOBS-3 dropped ADR-022's `scope`, `concurrency`, `timeoutMs`, `replayFrom`
 *     and the `dedupe.key` template: the dedupe key is the start's
 *     (`JobStarter.start({ dedupeKey })`), and a collision on it follows
 *     `collision`. A trigger declares its `schedule`/`event` and the emitter
 *     generates `map`/`when`.
 *   - No provider/adapter identity field (RFC-0005 OQ-4, decided (b)). Arms carry
 *     only `domain`; provider→use-case resolution stays swe-brain-side (the D5
 *     throwaway `(provider,domain)` registry), revisited when codegen #458 lands.
 *     A single job spans providers, so this is deliberately NOT a top-level field.
 *
 * Cadence is owned by the JOB (ADR-0018, overriding the brief's D4 event-owned
 * recommendation — "the job declares its own cadence; I'm not setting up timers
 * then attaching jobs"). `triggers[]` is a list of two arm shapes (0/1/N):
 *   - `schedule` arm — `{ schedule: ScheduleSchema }`, the AUTHORITATIVE cadence.
 *     The emitter desugars it into a generated, job-private scheduled event
 *     (ADR-039 `schedule:` block → `EventScheduler` tick) PLUS a bridge trigger,
 *     exactly as EMIT-CHANGES desugars `emit_changes` into generated change
 *     events. Reuses the events `ScheduleSchema` verbatim (one cadence vocabulary).
 *     Each schedule arm gets its OWN event — equal cadences do NOT coalesce; a
 *     shared tick is opt-in via an authored event + an `event` arm.
 *   - `event` arm — `{ event: <snake_case type> }`, references an EXISTING event
 *     (webhook doorbell, etc.); the emitter emits a bridge trigger. #8 validates
 *     the event exists. No cadence, no drift-check (nothing to drift against).
 *
 * Strictness boundary: the top level and every arm are `.strict()` (stray keys
 * rejected). The embedded `read:` leaf is the IMPORTED `DetectionConfigSchema`,
 * which is NOT strict (ADR-033 — reused verbatim, never widened), so a typo
 * INSIDE `read:`/`poll:`/`webhook:` (e.g. `eventIdFeld`) is silently stripped, not
 * rejected. The #6 loader / #8 validator / #9 smoke gate is the backstop for
 * read-leaf shape — do not add `.strict()` to the imported leaf.
 */

// ============================================================================
// Enums and constants
// ============================================================================

/** A retry backoff: `fixed` (each delay `baseMs`) or `exponential` (doubling from `baseMs`). JOBS-3 maps it onto
 *  `@pattern-stack/jobs`' `RetryPolicy` (`backoffCoefficient` 1 or 2). */
export const JOB_BACKOFF_STRATEGIES = ["fixed", "exponential"] as const;
export type JobBackoffStrategy = (typeof JOB_BACKOFF_STRATEGIES)[number];

/** What a start whose dedupe key already has an open run does (`@pattern-stack/jobs` `Collision`, JOBS-3). */
export const COLLISION_MODES = ["join", "queue", "replace"] as const;
export type CollisionMode = (typeof COLLISION_MODES)[number];

/** Source-usage shapes (ADR-0018). Discriminant of the `arms[]` union. */
export const ARM_KINDS = ["poll", "reconcile", "realtime"] as const;
export type ArmKind = (typeof ARM_KINDS)[number];

const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

// ============================================================================
// Policy sub-schemas — the declarative (YAML-authorable) projection of the
// corresponding `@pattern-stack/jobs` job options (JOBS-3).
// ============================================================================

/**
 * `RetryPolicy` (job-handler.base.ts). All four fields surfaced; `backoff` is
 * `fixed | exponential` (jobs), distinct from the events `linear | exponential`.
 */
const RetryPolicySchema = z
	.object({
		attempts: z.number().int().min(0).max(20),
		backoff: z.enum(JOB_BACKOFF_STRATEGIES),
		baseMs: z.number().int().positive(),
		nonRetryableErrors: z.array(z.string().min(1)).optional(),
	})
	.strict();

export type JobRetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * `dedupe` — the job's dedupe WINDOW (`@pattern-stack/jobs` `dedupeWindowMs`, JOBS-3): a start within it after a
 * run on the same dedupe key ended returns that run. The key is the start's (`JobStarter.start({ dedupeKey })`).
 * Distinct from `differ.unignore` (below).
 */
const DedupePolicySchema = z
	.object({
		windowMs: z.number().int().positive(),
	})
	.strict();

export type JobDedupePolicy = z.infer<typeof DedupePolicySchema>;

/**
 * `limits` — the most one run may use (`@pattern-stack/jobs` `JobLimits`, JOBS-3). A bridge or schedule start names
 * no budget, so a job is started within these. Each field is optional; an omitted one takes `DEFAULT_JOB_LIMITS`.
 */
const JobLimitsSchema = z
	.object({
		maxItems: z.number().int().positive().optional(),
		maxUsd: z.number().positive().optional(),
		maxCalls: z.number().int().positive().optional(),
		maxDurationMs: z.number().int().positive().optional(),
	})
	.strict();

/** A YAML job's limits when it names none (JOBS-3, a default taken): generous for a sync job, whose plain steps record
 * no spend or calls of their own; an hour bounds a run that hangs. */
export const DEFAULT_JOB_LIMITS = { maxItems: 1000, maxUsd: 10, maxCalls: 1000, maxDurationMs: 3_600_000 } as const;


/**
 * Per-job differ override (ADR-0018 D2). Adds field names back into the
 * DeepEqualDiffer's comparison set for this job, on top of the global
 * `integration.differ.unignore`. The classic case is `deletedAt` so tombstones
 * register as a change. Per-job differ WIRING is deferred (D2); the schema
 * freezes the authoring surface so swe-brain can express it today.
 */
const DifferOverrideSchema = z
	.object({
		// Deliberately `.min(1)`: the runtime `DeepEqualDifferOptions.unignore` accepts
		// `[]` (a harmless no-op), but an empty `differ` block in YAML is meaningless
		// and almost certainly an authoring mistake — reject it rather than silently
		// accept a pointless block. (Schema is intentionally stricter than the runtime.)
		unignore: z.array(z.string().min(1)).min(1),
	})
	.strict();

export type JobDifferOverride = z.infer<typeof DifferOverrideSchema>;

// ============================================================================
// Triggers — what fires the job (ADR-0018). A list of two arm shapes; 0/1/N.
// Cadence is owned by the JOB (the schedule arm), not a separate event YAML.
// ============================================================================

/**
 * Schedule arm — the AUTHORITATIVE cadence. The emitter desugars it into a
 * generated, job-private scheduled event (ADR-039 `schedule:` block) + a bridge
 * trigger; there is no separately-authored event and therefore no drift-check.
 * Reuses the events `ScheduleSchema` verbatim (`every`/`align`/`catchUp`/
 * `maxCatchUpSlots`) so jobs and events share one cadence vocabulary.
 */
const ScheduleTriggerSchema = z
	.object({
		schedule: ScheduleSchema,
	})
	.strict();

/**
 * Event arm — references an EXISTING event (a webhook doorbell, a domain event).
 * The emitter emits a bridge trigger; the cross-ref validator (breakdown #8)
 * checks the event exists in the generated `eventRegistry`. The runtime
 * `JobTrigger.map`/`when` functions are emitter-generated — not authored here.
 */
const EventTriggerSchema = z
	.object({
		event: z
			.string()
			.regex(SNAKE_CASE_RE, "trigger.event must be a snake_case event type"),
	})
	.strict();

/**
 * A trigger is exactly one of the two arms. A `z.union` over two `.strict()`
 * objects with disjoint keys: `{ schedule }` → schedule arm, `{ event }` →
 * event arm, `{}` or `{ schedule, event }` → rejected (neither matches).
 */
const TriggerSchema = z.union([ScheduleTriggerSchema, EventTriggerSchema]);

export type JobTriggerDef = z.infer<typeof TriggerSchema>;

// ============================================================================
// Arms — the multi-arm composite (ADR-0018 D1+D3). Discriminated on `kind`,
// each embedding a `DetectionConfig` leaf (REUSED, not redefined).
// ============================================================================

/** PollSync — DI-bound adapter walks the delta; cursor ADVANCES. mode: poll. */
const PollArmSchema = z
	.object({
		kind: z.literal("poll"),
		domain: z.string().regex(SNAKE_CASE_RE, "arm.domain must be snake_case"),
		read: DetectionConfigSchema,
	})
	.strict();

/**
 * ReconcileSync — windowed `sourceOverride` (now − window), tombstone
 * inference; cursor WITHHELD (never regress the watermark). mode: poll.
 * `cursorWithheld` is `true` by definition (literal) — a reconcile arm that
 * advanced its cursor would not be a reconcile.
 */
const ReconcileArmSchema = z
	.object({
		kind: z.literal("reconcile"),
		domain: z.string().regex(SNAKE_CASE_RE, "arm.domain must be snake_case"),
		window: z
			.object({ hours: z.number().positive().finite() })
			.strict(),
		cursorWithheld: z.literal(true).optional().default(true),
		read: DetectionConfigSchema,
	})
	.strict();

/**
 * RealtimeSync — webhook-staging drain (claim/ack in the handler), NOT a peer
 * primitive (ADR-0018 D1). Reuses `mode: webhook`. The staging table is
 * consumer-owned (the package refuses to own it).
 */
const RealtimeArmSchema = z
	.object({
		kind: z.literal("realtime"),
		domain: z.string().regex(SNAKE_CASE_RE, "arm.domain must be snake_case"),
		staging: z
			.object({
				table: z.string().min(1),
				pushAccelerate: z.boolean().optional(),
			})
			.strict(),
		read: DetectionConfigSchema,
	})
	.strict();

const ArmSchema = z.discriminatedUnion("kind", [
	PollArmSchema,
	ReconcileArmSchema,
	RealtimeArmSchema,
]);

export type JobArm = z.infer<typeof ArmSchema>;

// ============================================================================
// Top-level schema
// ============================================================================

const JobDefinitionSchemaCore = z
	.object({
		type: z
			.string()
			.regex(SNAKE_CASE_RE, "Job type must be snake_case starting with a letter"),
		// ── job-level options (JOBS-3): the step limiter, retry, collision, dedupe window ──
		pool: z.string().min(1).optional(),
		retry: RetryPolicySchema.optional(),
		collision: z.enum(COLLISION_MODES).optional(),
		dedupe: DedupePolicySchema.optional(),
		limits: JobLimitsSchema.optional(),
		// `triggers` is the 8th meta field, reshaped to the declarative surface.
		triggers: z.array(TriggerSchema).default([]),
		// ── job-definition additions ───────────────────────────────────────────
		differ: DifferOverrideSchema.optional(),
		arms: z.array(ArmSchema).min(1, "a job must declare at least one arm"),
		description: z.string().optional(),
	})
	.strict();

/**
 * Cross-arm invariant (ADR-0018 D1↔D3): the arm `kind` constrains the embedded
 * source `mode`. A realtime arm drains a `webhook` source; poll/reconcile arms
 * walk a `poll` source. The two-altitude unions are independent everywhere else
 * — a single job freely mixes realtime + poll arms (e.g. `inbound-sync`).
 */
export const JobDefinitionSchema = JobDefinitionSchemaCore.superRefine(
	(data, ctx) => {
		data.arms.forEach((arm, i) => {
			const mode = arm.read.mode;
			if (arm.kind === "realtime" && mode !== "webhook") {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `realtime arm '${arm.domain}' requires read.mode 'webhook' (got '${mode}'). Realtime is a webhook-drain shape (ADR-0018 D1).`,
					path: ["arms", i, "read", "mode"],
				});
			}
			if (
				(arm.kind === "poll" || arm.kind === "reconcile") &&
				mode !== "poll"
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `${arm.kind} arm '${arm.domain}' requires read.mode 'poll' (got '${mode}').`,
					path: ["arms", i, "read", "mode"],
				});
			}
		});
	},
);

export type JobDefinition = z.infer<typeof JobDefinitionSchema>;

// ============================================================================
// Validation helpers
// ============================================================================

export function validateJobDefinition(data: unknown): JobDefinition {
	return JobDefinitionSchema.parse(data);
}

export function safeValidateJobDefinition(data: unknown): {
	success: boolean;
	data?: JobDefinition;
	error?: z.ZodError;
} {
	const result = JobDefinitionSchema.safeParse(data);
	if (result.success) {
		return { success: true, data: result.data };
	}
	return { success: false, error: result.error };
}
