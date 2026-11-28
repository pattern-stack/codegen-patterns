/**
 * `@pattern-stack/jobs/testing`: tests, evals and scripts, never production code. The memory store, the contracts every store and every job pass, and fakes. The
 * contracts are framework-free: register each case with your runner (`for (const c of storeContract(make))
 * test(c.name, c.run)`).
 */

export {
  memoryRecorder,
  memoryResultRecorder,
} from './adapters/memory-recorder.ts';
export {
  MemoryJobStore,
  type MemoryStoreOptions,
} from './adapters/memory-store.ts';
export type { ContractCase } from './testing/contract.ts';
export { type FakeClock, fakeClock } from './testing/fake-clock.ts';
export {
  type LimiterHarness,
  limiterContract,
} from './testing/limiter-contract.ts';
export {
  type RecordingSink,
  recordingSink,
} from './testing/recording-sink.ts';
export { type ReplaySubject, replayContract } from './testing/replay.ts';
export { type StoreHarness, storeContract } from './testing/store-contract.ts';
export { type ExecutorHarness, executorContract } from './testing/executor-contract.ts';
export {
  hang,
  ids,
  scoreOf,
  TOY_CONTENT,
  type ToyCall,
  ToyInput,
  type ToyOptions,
  ToyOutput,
  toyScoring,
  toyStopping,
} from './testing/toy-jobs.ts';
export {
  TOY_LIMITS,
  toyInternal,
  toyPublicDry,
  toyPublicPublishing,
  toyPublicReadOnly,
} from './testing/toy-public-jobs.ts';
