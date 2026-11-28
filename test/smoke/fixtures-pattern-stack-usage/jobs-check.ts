/**
 * The pattern-stack smoke's jobs check (J-1), on Postgres, copied into the project's `src/` beside `crud-check.ts`.
 * Compiled with the project, so every key it reads is the composition's real API. Three modes, one per process:
 *
 * - `bridge <url>`: compose and start; create an account and an invoice; `invoice_created`'s drain starts
 *   `invoice.follow_up` in the event's transaction (trigger `event`), the executor's sweep picks it up, and its step
 *   reads the invoice and its account through the `billing` and `crm` modules the `jobDeps` module provided.
 * - `start-slow <url> <marker>`: compose and start; start `smoke.slow`; print its run id; stay up until killed.
 * - `resume <url> <marker> <runId>`: compose and start (a second process, after the first was killed mid-`wait`);
 *   release the step; the run completes, `first` having run once and `wait` twice.
 */
import fs from 'node:fs';
import { SYSTEM_TENANT } from '@pattern-stack/jobs';

import { composeApp } from './compose';

const assert = (ok: unknown, what: string): void => {
  if (!ok) throw new Error(`jobs-check: ${what}`);
};

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`jobs-check: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function bridge(url: string): Promise<void> {
  const app = composeApp({ databaseUrl: url });
  assert(app.order.indexOf('jobs') < app.order.indexOf('events'), `the events system is composed after jobs: ${app.order.join(', ')}`);
  assert(app.order.at(-1) === 'jobDeps', `the jobDeps module is composed last: ${app.order.join(', ')}`);
  await app.start();
  try {
    const account = await app.module('crm').account.useCases.create.execute({ name: 'Bridge Co', status: 'active' });
    const invoice = await app.module('billing').invoice.useCases.create.execute({ amountCents: 500, accountId: account.id });
    const jobs = app.system('jobs');
    // crud-check's invoice started one too: this invoice's run is the one whose input names it.
    const run = await until('the bridge-started run to complete', 20_000, async () => {
      for (const r of await jobs.store.listRuns({ tenantId: SYSTEM_TENANT, jobKey: 'invoice.follow_up', limit: 20 })) {
        const input = (await jobs.store.runInput(r.id)) as { invoiceId: string };
        if (input.invoiceId === invoice.id && r.status === 'completed') return r;
      }
      return undefined;
    });
    assert(run.trigger === 'event', `the bridge's run records an event trigger: ${run.trigger}`);
    const output = (await jobs.store.stepOutput(run.id, 'account')) as { accountName: string };
    assert(output.accountName === 'Bridge Co', `the factory's step read through billing and crm: ${JSON.stringify(output)}`);
    console.log(`bridge: invoice_created started ${run.id} (trigger event); its step read '${output.accountName}'`);
  } finally {
    await app.stop();
  }
}

async function startSlow(url: string, marker: string): Promise<void> {
  const app = composeApp({ databaseUrl: url });
  await app.start();
  const { run } = await app.system('jobs').starter.start('smoke.slow', { marker });
  console.log(`run ${run.id}`);
  // Stay up, mid-step, until the parent kills this process (SIGKILL: no stop, the lease is left to lapse).
  await new Promise(() => undefined);
}

async function resume(url: string, marker: string, runId: string): Promise<void> {
  const app = composeApp({ databaseUrl: url });
  fs.writeFileSync(`${marker}.release`, '');
  await app.start();
  try {
    const jobs = app.system('jobs');
    await until(`run ${runId} to complete after the restart`, 30_000, async () =>
      (await jobs.store.getRun(runId)).status === 'completed' ? true : undefined,
    );
    const output = (await jobs.store.stepOutput(runId, 'wait')) as { firstRuns: number; waitAttempts: number };
    assert(output.firstRuns === 1, `the completed step was not run again: first ran ${output.firstRuns} times`);
    assert(output.waitAttempts === 2, `the killed step ran again in the new process: ${output.waitAttempts} attempts`);
    console.log(`resume: ${runId} completed after the restart (first ran once, wait twice)`);
  } finally {
    await app.stop();
  }
}

const [mode, url, marker, runId] = process.argv.slice(2);
if (!url) throw new Error('usage: jobs-check <bridge|start-slow|resume> <database url> [marker] [run id]');
if (mode === 'bridge') await bridge(url);
else if (mode === 'start-slow') await startSlow(url, marker!);
else if (mode === 'resume') await resume(url, marker!, runId!);
else throw new Error(`jobs-check: unknown mode ${mode}`);
process.exit(0);
