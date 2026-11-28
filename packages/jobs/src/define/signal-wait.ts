import { JobDefinitionError } from '../model/errors.ts';
import { CODE_NAME } from './gate.ts';
import type {
  ErasedContext,
  ErasedWaitStep,
  SignalWaitOptions,
  WaitStepDefinition,
} from './step.ts';

/** `waitFor({ signal, value })`: its facts checked at definition time, never at a caller's signal. */
export function signalWait<C, V>(
  options: SignalWaitOptions<C, V>,
): WaitStepDefinition<C, V> {
  const { signal, value, accept, timeout } = options;
  if (!CODE_NAME.test(signal))
    throw new JobDefinitionError(
      `a signal's name is a code constant (lowercase letters, digits, '.', '_', '-'), not ${JSON.stringify(signal)}`,
    );
  if (timeout) {
    if (!(Number.isInteger(timeout.afterMs) && timeout.afterMs >= 1))
      throw new JobDefinitionError(
        `the signal ${signal}: timeout.afterMs must be a positive whole number of ms`,
      );
    if (
      timeout.fallback !== 'fail' &&
      !value.safeParse(timeout.fallback.value).success
    )
      throw new JobDefinitionError(
        `the signal ${signal}: its timeout's value does not match its value schema`,
      );
  }
  const erased: ErasedWaitStep = {
    kind: 'wait',
    signal,
    description: options.description,
    value,
    accept:
      accept &&
      (async (v: unknown, ctx: ErasedContext) => accept(v as V, ctx as C)),
    authority: options.authority,
    timeout: timeout && {
      afterMs: timeout.afterMs,
      fallback:
        timeout.fallback === 'fail'
          ? 'fail'
          : { value: timeout.fallback.value },
    },
    gates: [],
    limiters: [],
    retry: undefined,
    effect: 'idempotent',
  };
  return { kind: 'wait', erased };
}
