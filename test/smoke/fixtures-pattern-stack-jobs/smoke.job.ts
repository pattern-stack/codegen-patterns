/**
 * The pattern-stack smoke's jobs (J-1), copied into the project's `src/jobs/` before `entity new`:
 *
 * - `invoiceFollowUp`, a job FACTORY whose dependencies are two of the composition's modules (`billing` and `crm`),
 *   started by the bridge on `invoice_created` (its `jobTriggers` below): its step reads the invoice, then its account.
 * - `smokeSlow`, a plain job of two steps for the kill-and-restart check: `first` records each time it runs; `wait`
 *   records each attempt and holds until a release file exists. A process killed inside `wait` leaves the run open, and
 *   the next process resumes it from `wait` (so `first` ran once, `wait` twice).
 */
import fs from 'node:fs';
import { defineJob, injected, jobFactory, step } from '@pattern-stack/jobs';
import { z } from 'zod';

import type { BillingModule } from '../modules/billing/module';
import type { CrmModule } from '../modules/crm/module';
import { jobTriggers } from '../shared/subsystems/bridge/core';

const LIMITS = { maxItems: 10, maxUsd: 1, maxCalls: 10, maxDurationMs: 120_000 };

export const invoiceFollowUp = jobFactory({
  deps: { billing: injected<BillingModule>('billing'), crm: injected<CrmModule>('crm') },
  create: ({ billing, crm }) =>
    defineJob({
      key: 'invoice.follow_up',
      input: z.object({ invoiceId: z.string() }),
      output: z.object({ accountName: z.string() }),
      limits: LIMITS,
      steps: (s) =>
        s.add(
          'account',
          step({
            run: async (ctx) => {
              const invoice = await billing.invoice.useCases.findById.execute(ctx.input.invoiceId);
              const account = await crm.account.useCases.findById.execute(invoice.accountId);
              return { accountName: account.name };
            },
          }),
        ),
    }),
});

export const invoiceFollowUpTriggers = jobTriggers('invoice.follow_up', [
  { event: 'invoice_created', map: (e) => ({ invoiceId: e.aggregateId }) },
]);

const append = (file: string) => fs.appendFileSync(file, 'x');
const count = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0);

export const smokeSlow = defineJob({
  key: 'smoke.slow',
  input: z.object({ marker: z.string() }),
  output: z.object({ firstRuns: z.number(), waitAttempts: z.number() }),
  limits: LIMITS,
  steps: (s) =>
    s
      .add(
        'first',
        step({
          run: (ctx) => {
            append(`${ctx.input.marker}.first`);
            return { firstAt: Date.now() };
          },
        }),
      )
      .add(
        'wait',
        step({
          run: async (ctx) => {
            append(`${ctx.input.marker}.attempts`);
            while (!fs.existsSync(`${ctx.input.marker}.release`)) await new Promise((r) => setTimeout(r, 100));
            return { firstRuns: count(`${ctx.input.marker}.first`), waitAttempts: count(`${ctx.input.marker}.attempts`) };
          },
        }),
      ),
});
