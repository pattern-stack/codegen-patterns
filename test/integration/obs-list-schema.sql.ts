/**
 * Raw DDL for the two tables the OBS-LIST-1 Drizzle read backends bind to:
 *   - `job_run`       (runtime/subsystems/jobs/job-orchestration.schema.ts)
 *   - `domain_events` (runtime/subsystems/events/domain-events.schema.ts)
 *
 * Hand-written (rather than drizzle-kit push) so the integration test stays
 * self-contained — no extra build step, no drizzle.config, no codegen pass.
 * The columns/enums/CHECK mirror the schema files exactly; both backends do a
 * bare `SELECT *` and project in JS, so every column the projections read
 * (and every column the inserts write) must exist here.
 *
 * `job` is created too: `job_run.job_type` FK-references `job.type`, so a
 * `job` row must exist before any `job_run` insert. We seed one wide-open
 * definition the test runs all reference.
 *
 * Single-tenant schema variant (`tenant_id` nullable, runtime enforces the
 * gate via the JOBS_MULTI_TENANT flag) — matches
 * `test/baseline/.../job-orchestration.schema.single-tenant.ts`.
 */

/** Enums + tables, in dependency order. Run as one batch via pool.query. */
export const OBS_LIST_DDL = /* sql */ `
-- ─── enums (jobs) ───────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE job_run_status AS ENUM
    ('pending','running','waiting','completed','failed','timed_out','canceled');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE job_collision_mode AS ENUM ('queue','reject','replace');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE job_replay_from AS ENUM ('scratch','last_step','last_checkpoint');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE job_parent_close_policy AS ENUM ('terminate','cancel','abandon');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE job_wait_kind AS ENUM ('signal');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE job_trigger_source AS ENUM ('manual','schedule','event','parent');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── job ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job (
  type                     text PRIMARY KEY,
  version                  integer NOT NULL DEFAULT 1,
  pool                     text NOT NULL,
  scope_entity_type        text,
  retry_policy             jsonb NOT NULL,
  timeout_ms               integer,
  concurrency_key_template text,
  collision_mode           job_collision_mode NOT NULL DEFAULT 'queue',
  dedupe_key_template      text,
  dedupe_window_ms         integer,
  priority_default         integer NOT NULL DEFAULT 0,
  replay_from              job_replay_from NOT NULL DEFAULT 'last_checkpoint',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ─── job_run ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_run (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type            text NOT NULL REFERENCES job(type),
  job_version         integer NOT NULL,
  parent_run_id       uuid REFERENCES job_run(id),
  root_run_id         uuid NOT NULL,
  parent_close_policy job_parent_close_policy NOT NULL DEFAULT 'terminate',
  scope_entity_type   text,
  scope_entity_id     text,
  tenant_id           text,
  tags                jsonb NOT NULL DEFAULT '{}',
  pool                text NOT NULL,
  priority            integer NOT NULL DEFAULT 0,
  concurrency_key     text,
  dedupe_key          text,
  status              job_run_status NOT NULL DEFAULT 'pending',
  input               jsonb NOT NULL,
  output              jsonb,
  error               jsonb,
  trigger_source      job_trigger_source NOT NULL,
  trigger_ref         text,
  run_at              timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  claimed_at          timestamptz,
  attempts            integer NOT NULL DEFAULT 0,
  wait_kind           job_wait_kind,
  resume_token        text,
  wait_deadline       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ─── domain_events ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS domain_events (
  id             uuid PRIMARY KEY,
  type           text NOT NULL,
  aggregate_id   text NOT NULL,
  aggregate_type text NOT NULL,
  payload        jsonb NOT NULL,
  occurred_at    timestamptz NOT NULL,
  processed_at   timestamptz,
  status         text NOT NULL DEFAULT 'pending',
  error          text,
  metadata       jsonb,
  pool           text,
  direction      text,
  tier           text NOT NULL DEFAULT 'domain',
  tenant_id      text,
  CONSTRAINT domain_events_tier_routing_check CHECK (
    tier IN ('domain','audit')
    AND ((tier = 'audit') = (pool IS NULL AND direction IS NULL))
  )
);
`;
