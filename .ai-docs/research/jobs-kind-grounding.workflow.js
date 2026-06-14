export const meta = {
  name: 'jobs-kind-design-grounding',
  description: 'Verify the sync-job-primitives request anchors across swe-brain and codegen-patterns, then ground the 5 open design decisions and propose a PR-sized work breakdown',
  phases: [
    { title: 'Verify', detail: 'confirm cited file:line anchors in both repos' },
    { title: 'Decide', detail: 'one agent per open design decision, grounded in verified facts' },
    { title: 'Synthesize', detail: 'consolidated design brief and dependency-ordered work breakdown' },
  ],
}

const SWE = '/Users/dug/Projects/swe-brain/swe-brain'
const CG = '/Users/dug/Projects/codegen-patterns'

const ANCHOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cluster', 'anchors', 'summary'],
  properties: {
    cluster: { type: 'string' },
    anchors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'citedLocation', 'verdict', 'actualLocation', 'evidence'],
        properties: {
          claim: { type: 'string', description: 'the assertion, in one line' },
          citedLocation: { type: 'string', description: 'file:line as cited' },
          verdict: { type: 'string', enum: ['confirmed', 'drifted', 'refuted', 'not-found'] },
          actualLocation: { type: 'string', description: 'where the substance actually lives now (file:line), or n/a' },
          evidence: { type: 'string', description: 'short quote or paraphrase of what is actually there' },
        },
      },
    },
    surprises: { type: 'array', items: { type: 'string' }, description: 'anything found that contradicts or complicates the request' },
    summary: { type: 'string' },
  },
}

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'recommendation', 'confidence', 'rationale', 'options', 'schemaImplication', 'affects'],
  properties: {
    decision: { type: 'string' },
    recommendation: { type: 'string', description: 'the concrete call to make' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    rationale: { type: 'string' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['option', 'pros', 'cons'],
        properties: { option: { type: 'string' }, pros: { type: 'string' }, cons: { type: 'string' } },
      },
    },
    schemaImplication: { type: 'string', description: 'effect on the JobDefinitionSchema (A config equals B schema)' },
    affects: { type: 'object', additionalProperties: false, required: ['sweBrain', 'codegen'], properties: { sweBrain: { type: 'string' }, codegen: { type: 'string' } } },
    openItems: { type: 'array', items: { type: 'string' } },
  },
}

phase('Verify')

const verifiers = [
  {
    cluster: 'codegen-integration',
    prompt:
`You are verifying file:line anchors in the codegen-patterns repo at ${CG}. For EACH claim below, open the cited file (line numbers may have drifted — read plus/minus 50 lines and search the file for the substance), and report verdict: confirmed (substance present, maybe moved), drifted (present but materially different/moved far), refuted (contradicted), not-found.

Claims to verify (cluster: integration orchestrator + source builder + detection + the differ/input seams):
1. execute-integration.use-case.ts:113 — ExecuteIntegrationUseCase.execute() IS the single generic pull/diff/upsert/audit/cursor loop reused across every (provider, mode, entity).
2. build-change-source.ts:23 — buildChangeSource(cfg, fetch, middlewares) switches on cfg.mode of poll or webhook (and CDC-as-provenance). Report the exact mode enum it accepts.
3. detection-config.schema.ts — DetectionConfigSchema is discriminated on mode, with per-mode cursor strategy (systemModstamp/replayId/timestamp/historyId/syncToken/and so on), dedupKey, filters, mapping. Report the actual discriminant, the cursor strategy union, and the top-level fields.
4. ExecuteIntegrationInput — it carries a per-run sourceOverride but NO differOverride. CRITICAL: find where ExecuteIntegrationInput is DEFINED (which file), and state definitively whether it is package-owned (codegen runtime, i.e. under ${CG}/runtime) vs app-owned. This determines whether adding differOverride is a codegen change.
5. The dedupe/update policy is a SINGLE GLOBAL DeepEqualDiffer wired from codegen.config integration.differ.unignore. Confirm the differ is injected globally (one instance), not per-run. Report the DI token and where the global instance is constructed in runtime.

Report via the schema. Use cluster equal to codegen-integration.`,
  },
  {
    cluster: 'codegen-jobs-events-parser',
    prompt:
`You are verifying file:line anchors in the codegen-patterns repo at ${CG}. For EACH claim, open the cited file (line numbers may have drifted — read plus/minus 50 lines / search for substance) and report verdict.

Claims (cluster: jobs base + boot upsert + event schedule + parser gap):
1. job-handler.base.ts:114-128 — JobHandlerMeta shape includes pool, retry, concurrency, dedupe, timeoutMs, triggers. Report the ACTUAL full field list of JobHandlerMeta.
2. job-handler.base.ts:203-234 — JobHandler classes self-register into an in-code registry at class-load time. Report the registry mechanism.
3. job-worker.module.ts:191-212 — at boot, JobHandler classes are upserted into job rows from the in-code registry (NOT DB-seeded). Confirm.
4. event-definition.schema.ts:154-174 — there is a schedule block in the event-definition schema. Report its fields (cron/cadence/interval, timezone, and so on).
5. event-scheduler.ts — EventScheduler materializes scheduled ticks idempotently (not seeded). Confirm the idempotency mechanism.
6. THE GAP: codegen loads ONLY entities, events, providers, relationships, junctions. There is NO jobs definition kind, NO definitions/jobs/ loader, NO job-handler emitter. Verify by reading src/parser/load-entities.ts, src/parser/load-events.ts (around line 88), and the gen-walk discovery in src/cli/commands/entity.ts (around line 169). Confirm definitively that no jobs kind exists and report exactly what kinds the gen-walk discovers.

Report via schema. cluster equal to codegen-jobs-events-parser.`,
  },
  {
    cluster: 'swe-brain-sync-handlers',
    prompt:
`You are verifying file:line anchors in the swe-brain repo at ${SWE}. The relevant handlers live in ${SWE}/apps/backend/src/jobs/. For EACH claim, open the file (lines may have drifted) and report verdict.

Claims (cluster: the four sync handlers + duplicated shell + registry flag + global differ):
1. Four sync JobHandler classes exist: inbound-sync, reconcile-poll, google-reconcile, drive-poll (files: inbound-sync.job-handler.ts, reconcile-poll.job-handler.ts, google-reconcile.job-handler.ts, drive-poll.job-handler.ts).
2. The COPY-PASTED shell across the four is: env-disable gate, then connection resolve, then ADR-0016 surface gate, then per-domain execute(), then a re-declared PhaseSummary struct. Confirm a PhaseSummary struct is re-declared in reconcile-poll (around line 84), google-reconcile (around line 110), drive-poll (around line 103). Quote each PhaseSummary declaration so we can judge how identical they are.
3. THE THREE SHAPES — read how each handler calls ExecuteIntegrationUseCase.execute():
   - PollSync: NO sourceOverride, cursor ADVANCES (drive-poll; mail/calendar arms of google-reconcile; Google arms of inbound-sync).
   - ReconcileSync: windowed sourceOverride (now minus window) + tombstone inference, cursor WITHHELD (reconcile-poll; transcript arm of google-reconcile).
   - RealtimeSync: webhook-staging sourceOverride + claim/ack drain loop (Slack message/reaction arms of inbound-sync).
   Confirm each shape by quoting the relevant execute()-call sites. This is the load-bearing taxonomy claim — scrutinize it.
4. inbound-sync.job-handler.ts:45-49 and :318-322 + inbound-jobs.module.ts:18-24 — the code hand-injects named (provider,domain) use-case tokens and flags the future codegen #458 (provider,domain)->use-case registry collapse. Confirm.
5. apps/backend/src/generated/subsystems.ts:27 — the global DeepEqualDiffer is constructed there from integration.differ.unignore of [deletedAt]. Confirm.

Report via schema. cluster equal to swe-brain-sync-handlers.`,
  },
  {
    cluster: 'swe-brain-scope-cadence-priorart',
    prompt:
`You are verifying claims in the swe-brain repo at ${SWE}. Report verdicts.

Claims (cluster: out-of-scope handlers + cadence home + context layout + prior art):
1. FOUR non-sync handlers are correctly OUT of scope because they are NOT IChangeSource-driven. Confirm by reading each:
   - watch-renewal.job-handler.ts — direct repo sweep, no change-source.
   - trigger-runner.job-handler.ts + schedule-dispatcher.job-handler.ts — the Predicate/Directive seam; look at ${SWE}/apps/backend/src/triggers/execute.ts.
   - transcript-extraction.job-handler.ts — thin reflex over ExtractObservationsUseCase.
2. CADENCE HOME TODAY: where do the cadences (cron/interval) for the four sync jobs actually live right now? Search ${SWE}/apps/backend (or wherever definitions/events/** lives — find it) for schedule YAML blocks tied to these jobs. Report the exact files and cadence values for inbound-sync / reconcile-poll / google-reconcile / drive-poll.
3. CONTEXT LAYOUT: is apps/backend/src/jobs/ organized by bounded context today (messaging/mail/calendar/transcript/document subfolders) or FLAT? The request proposes moving to per-context subfolders — report current reality.
4. PRIOR ART for D3: the request mentions that W3 extraction already uses declarative derivation profiles for chunking. Find this in swe-brain (search for derivation profile / chunking / W3 / extraction config). Summarize the profile pattern — is it a YAML/object-driven config that could be a template for the job-profile schema?
5. The request says system JobHandler jobs are upserted at boot (no DB seeding) and the ONLY magic seeding (seed-schedules.ts / seed-directives.ts) is for user automations (out of scope). Find seed-schedules.ts / seed-directives.ts and confirm they seed user automations, not system jobs.

Report via schema. cluster equal to swe-brain-scope-cadence-priorart.`,
  },
]

const facts = await parallel(
  verifiers.map((v) => () => agent(v.prompt, { label: 'verify:' + v.cluster, phase: 'Verify', schema: ANCHOR_SCHEMA }))
)
const verified = facts.filter(Boolean)
const factsDigest = JSON.stringify(verified, null, 1)
log('Verification complete: ' + verified.length + ' clusters. Grounding the 5 design decisions...')

phase('Decide')

const decisions = [
  {
    key: 'D1-realtime-peer-vs-mode',
    prompt:
`Open design decision 1: Is RealtimeSync a PEER primitive (3 peers: Poll/Reconcile/Realtime) or a webhook-DRAIN MODE on top of Poll/Reconcile (2 primitives + a mode)? RealtimeSync is the only one with a claim/ack loop over a webhook-staging table.
Read ${CG}/runtime/subsystems/integration/build-change-source.ts (the mode switch of poll or webhook) and the swe-brain Slack realtime arm in ${SWE}/apps/backend/src/jobs/inbound-sync.job-handler.ts. Consider that build-change-source ALREADY has a webhook mode — does realtime collapse into webhook-mode-plus-drain, making it a mode not a peer? Recommend.`,
  },
  {
    key: 'D2-differ-override',
    prompt:
`Open design decision 2: Add a per-run differOverride on ExecuteIntegrationInput (mirroring sourceOverride) so ReconcileSync can carry a configurable dedupe/update strategy — OR is the single global unignore policy enough for now? KEY FACT from verification: whether ExecuteIntegrationInput is package-owned (codegen runtime) decides if this is a codegen change that B must subsume. Read ${CG}/runtime/subsystems/integration/execute-integration.use-case.ts and the input type definition, plus ${CG}/runtime/subsystems/integration/detection-config.schema.ts (does per-mode dedupKey already cover the need?). Recommend, and state clearly whether differOverride should be: (a) an A-side app seam first then lifted, (b) a codegen change from the start, or (c) deferred (global unignore suffices).`,
  },
  {
    key: 'D3-detection-adopt-vs-fresh',
    prompt:
`Open design decision 3: Should B per-adapter job profile ADOPT codegen existing detection config (DetectionConfigSchema) as its dedupe/cursor/window/filters/mapping backbone, or roll a FRESH profile shape? swe-brain deliberately avoids detection today. Read ${CG}/runtime/subsystems/integration/detection-config.schema.ts fully and assess coverage vs the request profile fields (cadence, window, dedupe.unignore, pool, lane, stagingSource/pushSource, pushAccelerate). Also weigh the W3 declarative derivation profiles prior art surfaced in verification. Recommend: reuse DetectionConfigSchema (composed into JobDefinitionSchema), extend it, or fresh — with the schema-shape consequence.`,
  },
  {
    key: 'D4-cadence-home',
    prompt:
`Open design decision 4: Where does cadence live — the existing event-YAML schedule block (status quo, codegen EventScheduler materializes ticks), or INSIDE the job profile (one declaration per job)? The request recommends the profile. Read ${CG}/src/schema/event-definition.schema.ts (schedule block) and ${CG}/runtime/subsystems/events/event-scheduler.ts, and consider verification finding on where swe-brain cadences live today. One source must win. Recommend, and specify how the job profile would express cadence and how it wires to EventScheduler (does the job emitter ALSO emit a schedule event, or does the scheduler learn to read job definitions?).`,
  },
  {
    key: 'D5-registry-source',
    prompt:
`Open design decision 5: The generic handler needs a (provider,domain)->use-case lookup. Wait for codegen #458 to ship that registry, or hand-build a small LOCAL registry in swe-brain (A) now? Read the swe-brain hand-injected tokens in ${SWE}/apps/backend/src/jobs/inbound-jobs.module.ts and inbound-sync.job-handler.ts, and check codegen-patterns issue #458 framing (the assembly use-case registry). Recommend the sequencing: does A build a throwaway local registry now (deleted when #458 lands), or should #458 be pulled forward as a B dependency? Note the dependency edge for the work breakdown.`,
  },
]

const resolved = await parallel(
  decisions.map((d) => () =>
    agent(d.prompt + '\n\n--- VERIFIED FACTS (JSON, use these; do not re-derive) ---\n' + factsDigest, {
      label: 'decide:' + d.key,
      phase: 'Decide',
      schema: DECISION_SCHEMA,
    })
  )
)
const resolvedDecisions = resolved.filter(Boolean)
log('Decisions grounded: ' + resolvedDecisions.length + '/5. Synthesizing design brief + work breakdown...')

phase('Synthesize')

const synthesisPrompt =
`You are the synthesis lead. You have (1) verified anchor facts and (2) five grounded design-decision recommendations for a cross-repo feature: sync-job primitives (Part A, swe-brain at ${SWE}) lifted into a codegen jobs definition kind plus emitter (Part B, codegen-patterns at ${CG}). The load-bearing constraint: A per-adapter sync-profile object IS B JobDefinitionSchema (A config equals B schema).

Produce a SINGLE consolidated design brief in Markdown with these sections:

## 1. Anchor verification verdict
A compact table of any DRIFTED / REFUTED / NOT-FOUND anchors (skip the plainly-confirmed ones, but state the overall confidence: did the request research hold up?). Flag anything that changes the plan.

## 2. Resolved design decisions
For each of the 5 decisions: the recommended call, confidence, one-line rationale, and the resulting schema implication. Where two decisions interact (for example D1 mode-vs-peer changes the schema primitive field; D3 detection-adoption changes the dedupe/cursor fields), say so.

## 3. Proposed JobDefinitionSchema (B) / sync-profile shape (A)
A concrete draft of the YAML schema that satisfies the A-to-B contract, reconciling all 5 resolved decisions. Show it as an annotated YAML example covering poll / reconcile / realtime cases. This is the single most important artifact — it is the thing A builds against and B compiles.

## 4. Dependency-ordered work breakdown (PR-sized)
A numbered list of PR-sized issues spanning BOTH repos. For each: [repo] title — one-line scope — dependsOn (issue numbers in this list) — rough size (S/M/L). Order so that: shared schema/ADR is locked first; A primitives plus profiles are built and behaviour-verified; then B lifts the shape; then swe-brain dogfoods B (deletes A hand-built primitives, re-expresses as YAML). Call out the codegen-patterns main-to-npm auto-deploy coordination step explicitly as its own gated item. Note where codegen #458 (D5) sits in the order.

## 5. ADR outline
A skeleton for the swe-brain ADR-0018+ (the three shapes, the per-adapter composition table, the A-to-B contract, and the resolutions to the 5 decisions).

## 6. Risks and watch-items
Top risks (behaviour-parity verification for A; npm-deploy coupling; schema churn between A-build and B-lift; anything verification surfaced as a surprise).

Be concrete and decisive — this brief feeds an SDLC plan. Do not hedge with could-go-either-way; make the call and note the fallback.

--- VERIFIED FACTS (JSON) ---
${factsDigest}

--- RESOLVED DECISIONS (JSON) ---
${JSON.stringify(resolvedDecisions, null, 1)}`

const brief = await agent(synthesisPrompt, { label: 'synthesize:brief', phase: 'Synthesize' })

return { brief, verified, resolvedDecisions }
