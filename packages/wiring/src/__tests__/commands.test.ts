import { describe, expect, it } from 'bun:test';
import { defineCommand, done, onApis, refuse, type InputSchema } from '../commands';

/** A schema by hand, the shape Zod's `safeParse` has. */
const nameInput: InputSchema<{ name: string }> = {
  safeParse: (v) =>
    typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string'
      ? { success: true, data: { name: (v as { name: string }).name } }
      : { success: false, error: { issues: [{ path: ['name'], code: 'invalid_type', message: 'expected a string' }] } },
};

interface Greeter {
  greet(name: string): string | null;
}

const greet = defineCommand<Greeter, { name: string }, string>({
  name: 'greeter greet',
  summary: 'Greet someone',
  effect: 'read',
  input: nameInput,
  run: async (apis, { name }) => {
    const said = apis.greet(name);
    return said === null ? refuse('not-found', `no one called ${name}`, 'greet someone who is here') : done(said);
  },
});

describe('commands', () => {
  it('runs to a result or a refusal', async () => {
    const apis: Greeter = { greet: (n) => (n === 'ada' ? `hello ${n}` : null) };
    expect(await greet.run(apis, { name: 'ada' }, {})).toEqual({ ok: true, result: 'hello ada' });
    expect(await greet.run(apis, { name: 'bob' }, {})).toEqual({
      ok: false,
      refusal: { reason: 'not-found', detail: 'no one called bob', instead: 'greet someone who is here' },
    });
  });

  it('carries data on a refusal only when given', () => {
    expect(refuse('bad', 'what', 'instead', { code: 'x' }).refusal.data).toEqual({ code: 'x' });
    expect('data' in refuse('bad', 'what', 'instead').refusal).toBe(false);
  });

  it('refuses a reason that is not a slug, and a refusal with no words', () => {
    expect(() => refuse('Not Found', 'what', 'instead')).toThrow(/slug/);
    expect(() => refuse('bad', '', 'instead')).toThrow(/what happened/);
  });

  it('re-targets a command onto a larger set of APIs', async () => {
    const app = { greeters: { english: { greet: (n: string) => `hello ${n}` } as Greeter } };
    const onApp = onApis(greet, (a: typeof app) => a.greeters.english);
    expect(onApp.name).toBe('greeter greet');
    expect(onApp.effect).toBe('read');
    expect(await onApp.run(app, { name: 'ada' }, {})).toEqual({ ok: true, result: 'hello ada' });
  });
});
