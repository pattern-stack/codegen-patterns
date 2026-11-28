/**
 * Raw DDL for the table the OBS-LIST-1 Drizzle read backend binds to:
 *   - `domain_events` (runtime/subsystems/events/domain-events.schema.ts)
 *
 * (JOBS-3 dropped observability's job reads, and with them ADR-022's `job` /
 * `job_run` tables here.)
 *
 * Hand-written (rather than drizzle-kit push) so the integration test stays
 * self-contained — no extra build step, no drizzle.config, no codegen pass.
 * The columns/CHECK mirror the schema file exactly; the backend does a bare
 * `SELECT *` and projects in JS, so every column the projection reads (and
 * every column the inserts write) must exist here.
 */

/** The table, as one batch via pool.query. */
export const OBS_LIST_DDL = /* sql */ `
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
