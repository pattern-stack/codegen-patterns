/**
 * `redisLimiters` against a real Valkey: the same `limiterContract` the in-memory limiters pass, with two ioredis
 * clients as two holders of one set of buckets, the way two worker processes hold them. The ACQUIRE and RELEASE scripts
 * (the cap across holders, the window, the shared 429 block, lease expiry, one bucket per key) run nowhere else in this
 * repo. Part of `just test-jobs-integration`; without Docker it fails rather than skip, because a gate that can't run
 * can't fail.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import Redis from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

import { evalScripting, redisLimiters } from '@pattern-stack/jobs/redis';
import { limiterContract } from '@pattern-stack/jobs/testing';

let container: StartedTestContainer;
const clients: Redis[] = [];

beforeAll(async () => {
  container = await new GenericContainer('valkey/valkey:8-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
}, 120_000);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.quit()));
  await container?.stop();
});

const client = () => {
  const c = new Redis({ host: container.getHost(), port: container.getMappedPort(6379), lazyConnect: false });
  clients.push(c);
  return evalScripting(c);
};

describe('redisLimiters on Valkey: the limiter contract', () => {
  for (const c of limiterContract({
    make: (config, clock) => [redisLimiters(client(), config, { clock }), redisLimiters(client(), config, { clock })],
  }))
    test(c.name, c.run, 30_000);
});
