---
to: "<%= schemaPath %>"
force: true
skip_if: "<%= skipSchema %>"
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
/**
 * The job engine's tables (JOBS-3): `@pattern-stack/jobs/postgres` owns them, and this app's schema barrel
 * re-exports them from here, so its migrations create them. `job_runs` (one durable execution), `job_run_steps`,
 * `job_run_items` and `job_run_chunks` (the bookkeeping), `job_run_values` and `job_item_results` (a job's values as
 * JSON), `job_run_events` (the event log). The tenant column is `text`; a single-tenant app's runs are
 * `SYSTEM_TENANT`'s.
 */
export * from '@pattern-stack/jobs/schema';
