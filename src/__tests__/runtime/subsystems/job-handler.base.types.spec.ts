/**
 * Type-level compile-check for `JobHandlerBase` + `@JobHandler` (JOB-2).
 *
 * The value of this file is that `tsc` must be able to infer `ctx.input`
 * as `OnboardingInput` (with no cast) and `run`'s return as
 * `Promise<OnboardingOutput>`. The runtime `expect(true)` below only
 * exists so Bun counts this file as a test — the real contract is that
 * this module compiles.
 */
import 'reflect-metadata';
import { describe, it, expect } from 'bun:test';
import {
  JobHandler,
  JobHandlerBase,
  type JobContext,
} from '../../../../runtime/subsystems/jobs/job-handler.base';

interface OnboardingInput {
  userId: string;
  plan: 'free' | 'pro';
}

interface OnboardingOutput {
  welcomeEmailSent: boolean;
}

@JobHandler<OnboardingInput>('onboarding.types-test', {
  pool: 'batch',
  retry: { attempts: 3, backoff: 'exponential', baseMs: 1000 },
})
class OnboardingHandler extends JobHandlerBase<OnboardingInput, OnboardingOutput> {
  async run(ctx: JobContext<OnboardingInput>): Promise<OnboardingOutput> {
    // Must compile with no `as` / no generic re-annotation.
    const _userId: string = ctx.input.userId;
    const _plan: 'free' | 'pro' = ctx.input.plan;

    // `ctx.run` is the `JobRun` row type.
    const _runId: string = ctx.run.id;

    // `ctx.step` preserves its inner return type.
    const _stepResult: Promise<number> = ctx.step('noop', async () => 1);

    void _userId;
    void _plan;
    void _runId;
    void _stepResult;

    return { welcomeEmailSent: true };
  }
}

describe('JobHandlerBase — type compilation', () => {
  it('decorated handler class compiles with strict generic flow', () => {
    // Purely existence check — the important assertion is that this file
    // type-checks. If `ctx.input` widened to `unknown`, the cast-free
    // reads above would fail compilation.
    expect(OnboardingHandler).toBeDefined();
  });
});
