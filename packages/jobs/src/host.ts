/**
 * `@pattern-stack/jobs/host`: the framework-free parts a host composes the engine from (codegen J-1): the budget rule,
 * the system start and its submit rule, the in-process engine's builder, the active-span and fan-out sinks, and the limiter boot check. The Nest layer (`./nest`) is these under Nest's
 * exceptions and logger; a plain host (`@pattern-stack/wiring`) uses them as they are.
 */
export { type AskedBudget, JobBudgetError, resolveBudget } from './host/budget.ts';
export { assertLimitersConfigured, limitersUnconfigured } from './host/limiters.ts';
export { activeSpanSink, fanOutSinks } from './host/sinks.ts';
export {
  startSystemRun,
  type SystemStartParts,
  type SystemStartRequest,
  submitRun,
} from './host/system-start.ts';
export {
  type EngineStore,
  engineSinks,
  inProcessExecutor,
  inProcessLimiters,
  type InProcessKnobs,
} from './host/in-process.ts';
