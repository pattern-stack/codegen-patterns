import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createRegistry, defineJob, injected, isJobFactory, jobFactory, step, tokenOf } from '../index.ts';
import { MemoryJobStore } from '../testing.ts';
import { runToCompletion } from '../index.ts';

class Greeter {
  greet(name: string): string {
    return `hello ${name}`;
  }
}
const COUNTER = Symbol('counter');
interface Counter {
  bump(): number;
}

const greeting = jobFactory({
  deps: { greeter: Greeter, counter: injected<Counter>(COUNTER) },
  create: ({ greeter, counter }) =>
    defineJob({
      key: 'toy.greeting',
      input: z.object({ name: z.string() }),
      output: z.object({ text: z.string(), n: z.number() }),
      limits: { maxItems: 1, maxUsd: 1, maxCalls: 1, maxDurationMs: 60_000 },
      steps: (s) => s.add('greet', step({ run: ({ input }) => ({ text: greeter.greet(input.name), n: counter.bump() }) })),
    }),
});

describe('jobFactory', () => {
  it('names its dependencies by token: a class, or a string / symbol through injected', () => {
    expect(isJobFactory(greeting)).toBe(true);
    expect(tokenOf(greeting.deps.greeter)).toBe(Greeter);
    expect(tokenOf(greeting.deps.counter)).toBe(COUNTER);
  });

  it('a plain defineJob value is not a factory', () => {
    expect(isJobFactory(greeting.create({ greeter: new Greeter(), counter: { bump: () => 1 } }))).toBe(false);
  });

  it('create with the dependencies is an ordinary job: the steps reach them', async () => {
    let n = 0;
    const job = greeting.create({ greeter: new Greeter(), counter: { bump: () => ++n } });
    expect(createRegistry([job]).has('toy.greeting')).toBe(true);
    const outcome = await runToCompletion(
      job,
      { input: { name: 'ada' }, tenantId: 't', trigger: 'agent', requestedBy: null, budget: { maxItems: 1 } },
      { store: new MemoryJobStore(), executor: { pollMs: 1 } },
    );
    expect(outcome.output).toEqual({ text: 'hello ada', n: 1 });
  });
});
