/**
 * Token uniqueness test for the jobs domain layer (JOB-2).
 *
 * The three injection tokens must be `Symbol` values and distinct from each
 * other — this is the only guarantee Nest's token-based DI relies on.
 */
import { describe, it, expect } from 'bun:test';
import {
  JOB_ORCHESTRATOR,
  JOB_RUN_SERVICE,
  JOB_STEP_SERVICE,
} from '../../../../runtime/subsystems/jobs/jobs-domain.tokens';

describe('jobs-domain.tokens', () => {
  it('exports three Symbol tokens', () => {
    expect(typeof JOB_ORCHESTRATOR).toBe('symbol');
    expect(typeof JOB_RUN_SERVICE).toBe('symbol');
    expect(typeof JOB_STEP_SERVICE).toBe('symbol');
  });

  it('each token is distinct from the others', () => {
    expect(JOB_ORCHESTRATOR).not.toBe(JOB_RUN_SERVICE);
    expect(JOB_ORCHESTRATOR).not.toBe(JOB_STEP_SERVICE);
    expect(JOB_RUN_SERVICE).not.toBe(JOB_STEP_SERVICE);
  });

  it('symbols carry their namespaced key as description (ADR-037)', () => {
    expect(JOB_ORCHESTRATOR.description).toBe('@pattern-stack/codegen.jobs.orchestrator');
    expect(JOB_RUN_SERVICE.description).toBe('@pattern-stack/codegen.jobs.run-service');
    expect(JOB_STEP_SERVICE.description).toBe('@pattern-stack/codegen.jobs.step-service');
  });

  it('are global-registry symbols that match by value across copies (ADR-037)', () => {
    // The whole point of Symbol.for: re-deriving the key yields the SAME symbol,
    // so a package copy and a vendored copy of the runtime resolve identically.
    expect(JOB_ORCHESTRATOR).toBe(Symbol.for('@pattern-stack/codegen.jobs.orchestrator'));
    expect(JOB_RUN_SERVICE).toBe(Symbol.for('@pattern-stack/codegen.jobs.run-service'));
    expect(JOB_STEP_SERVICE).toBe(Symbol.for('@pattern-stack/codegen.jobs.step-service'));
  });
});
