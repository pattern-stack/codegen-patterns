import { describe, test } from 'bun:test';
import { memoryRecorder } from '../adapters/memory-recorder.ts';
import { MemoryJobStore } from '../adapters/memory-store.ts';
import { replayContract } from '../testing/replay.ts';
import { toyScoring, toyStopping } from '../testing/toy-jobs.ts';

const request = (n: number) => ({
  input: { n },
  tenantId: 'tenant-replay',
  trigger: 'eval' as const,
  requestedBy: null,
  budget: { maxItems: n },
});

const subjects = [
  { name: 'toy.scoring', job: toyScoring().job, request: request(9) },
  {
    name: 'toy.scoring with a bad item',
    job: toyScoring({ bad: ['o004'], batchMax: 3 }).job,
    request: request(9),
  },
  {
    name: 'toy.scoring with a recorded step',
    job: toyScoring({ recorder: memoryRecorder() }).job,
    request: request(5),
  },
  { name: 'toy.stopping', job: toyStopping().job, request: request(30) },
  {
    name: 'toy.scoring whose provider fails once with a 503',
    job: toyScoring({ transientCalls: 1 }).job,
    request: request(6),
  },
  {
    name: 'toy.stopping with every value in a recorder, on a store that keeps none',
    job: toyStopping({ recorded: true }).job,
    request: request(30),
    makeStore: (now: () => Date) =>
      new MemoryJobStore({ now, keepsValues: false }),
  },
];

for (const subject of subjects)
  describe(`replayContract: ${subject.name}`, () => {
    for (const c of replayContract(subject)) test(c.name, c.run);
  });
