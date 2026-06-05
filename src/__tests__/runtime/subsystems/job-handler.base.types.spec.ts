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
  FN_KEY_SENTINEL,
  keySelectorToTemplate,
  type JobContext,
  type JobTrigger,
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

// ── BRIDGE-6 follow-up: `@JobHandler({ triggers })` authoring type ──────────
// The contract: a real decorator carrying `triggers` must COMPILE, and `map` /
// `when` must see the event NARROWED to its payload (not the full union). The
// bridge-registry-generator's own tests scan source as strings and never
// compile a decorator — so this is the coverage that the missing
// `JobHandlerMeta.triggers` field would otherwise have failed silently.

interface IntegrationContactInput {
  contactId: string;
}

@JobHandler<IntegrationContactInput>('contact.writeback.types-test', {
  pool: 'external_crm',
  triggers: [
    {
      event: 'contact_created',
      // `e` must narrow to ContactCreatedEvent — payload access is cast-free.
      map: (e) => {
        const _type: 'contact_created' = e.type;
        const _contactId: string = e.payload.contactId;
        const _accountId: string | null = e.payload.accountId;
        void _type;
        void _accountId;
        return { contactId: _contactId };
      },
      when: (e) => e.payload.accountId !== null,
    },
  ],
})
class ContactWritebackHandler extends JobHandlerBase<IntegrationContactInput, void> {
  async run(_ctx: JobContext<IntegrationContactInput>): Promise<void> {}
}

// Negative: only known `EventTypeName` literals are valid trigger events.
// @ts-expect-error 'not_a_real_event' is not a known event type
const _badEvent: JobTrigger<IntegrationContactInput>['event'] = 'not_a_real_event';
void _badEvent;

describe('JobHandlerMeta.triggers — authoring type (BRIDGE-6 follow-up)', () => {
  it('@JobHandler({ triggers }) compiles and narrows map/when per event', () => {
    expect(ContactWritebackHandler).toBeDefined();
  });
});

// ── JOB-FN-KEY (0.16.2): both key forms compile + project correctly ─────────
// The typed `key` accepts BOTH a `{{field}}` template string AND a function of
// the input. The string form is unchanged; the function form is the one that
// previously typed-checked (the type REQUIRED a function) but was dropped at
// registration. Both must compile under one `@JobHandler`.

interface SlackInboundInput {
  channel: string;
  ts: string;
  eventId: string;
}

@JobHandler<SlackInboundInput>('slack.inbound.types-test', {
  pool: 'batch',
  // Function form — arbitrary projection of the input into a lane key.
  concurrency: { key: (input) => `chan:${input.channel}`, collisionMode: 'queue' },
  // String-template form on the dedupe policy in the same handler.
  dedupe: { key: '{{eventId}}', windowMs: 30_000 },
})
class SlackInboundHandler extends JobHandlerBase<SlackInboundInput, void> {
  async run(_ctx: JobContext<SlackInboundInput>): Promise<void> {}
}

describe('JobKeySelector — both key forms (JOB-FN-KEY)', () => {
  it('@JobHandler accepts a function concurrency key + a template dedupe key', () => {
    expect(SlackInboundHandler).toBeDefined();
  });

  it('keySelectorToTemplate projects each form for the definition row', () => {
    expect(keySelectorToTemplate('{{eventId}}')).toBe('{{eventId}}');
    expect(keySelectorToTemplate((i: { x: string }) => i.x)).toBe(FN_KEY_SENTINEL);
    expect(keySelectorToTemplate(undefined)).toBeNull();
  });
});
