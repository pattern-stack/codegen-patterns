/**
 * IncrementalReadBase<T, F, M> + mapConcurrent unit tests (RFC-0003 R1)
 *
 * Validates the providing base for the enumerate/hydrate read primitive.
 *
 * Key invariants under test:
 *   - `read()` drains enumerate pages and yields one `SourcedRecord<T>` per
 *     kept, hydrated, decodable ref — carrying `{ externalId, record, raw,
 *     cursor }` with the per-ref cursor passed through verbatim
 *   - FILTER BEFORE HYDRATE: a ref rejected by `matchesRef` is never handed to
 *     `hydrate` (structural, not disciplinary)
 *   - `matchesRecord` is the post-hydrate floor (the no-pushdown case)
 *   - `hydrate` is keyed + miss-tolerant: a missing/`null` raw is skipped, never
 *     fabricated, and does not shift alignment
 *   - `toCanonical` returning `null` drops the record
 *   - `get()` (RandomRead) is provided for free as `toCanonical ∘ hydrate([id])`
 *   - `enumerate` is LAZY/pull-driven — page N is hydrated before page N+1 is
 *     pulled (backpressure)
 *   - `listChanges` adapts `read()` → `Change<T>`: null cursor → `full` mode,
 *     non-null → `delta`; stamps `operation: 'updated'` + default `source`
 *   - `mapConcurrent` collects keyed results, respects the concurrency bound,
 *     and short-circuits on empty input
 */
import { describe, it, expect } from 'bun:test';
import {
  IncrementalReadBase,
  mapConcurrent,
  type ReadMode,
  type Ref,
} from '../../../../runtime/subsystems/integration/incremental-read';
import type { IntegrationSubscriptionView } from '../../../../runtime/subsystems/integration/integration-change-source.protocol';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Email {
  id: string;
  subject: string;
}

interface EmailFilter {
  unreadOnly?: boolean;
}

interface EmailMeta {
  unread: boolean;
}

const subscription: IntegrationSubscriptionView = {
  id: 'sub-1',
  domain: 'email',
  externalRef: 'google-acct-A',
};

/** A raw vendor payload as `hydrate` would return it. `null` subject → undecodable. */
interface RawMsg {
  id: string;
  subject: string | null;
}

interface HarnessOptions {
  /** Ref pages enumerate will yield, in order. */
  pages: Ref<EmailMeta>[][];
  /** Raw payloads keyed by id; a missing key models a hydrate miss (404). */
  raws: Record<string, RawMsg>;
  /** Records the ids each hydrate() call received, in call order. */
  hydrateCalls: string[][];
}

/**
 * Test adapter. `enumerate` replays the configured pages and records when each
 * page is pulled (to prove laziness); `hydrate` returns configured raws and
 * records the ids it saw; `toCanonical` drops a payload with a null subject.
 */
class TestEmailRead extends IncrementalReadBase<Email, EmailFilter, EmailMeta> {
  readonly label = 'test-email';
  /** Pull order log: `enum:N` when page N is pulled, `hydrate` per hydrate call. */
  readonly trace: string[] = [];
  lastMode: ReadMode | null = null;
  lastPageSize: number | undefined = undefined;

  constructor(private readonly opts: HarnessOptions) {
    super();
  }

  protected async *enumerate(
    mode: ReadMode,
    _filter?: EmailFilter,
    pageSize?: number,
  ): AsyncIterable<Ref<EmailMeta>[]> {
    this.lastMode = mode;
    this.lastPageSize = pageSize;
    for (let i = 0; i < this.opts.pages.length; i++) {
      this.trace.push(`enum:${i}`);
      yield this.opts.pages[i]!;
    }
  }

  protected async hydrate(ids: string[]): Promise<Map<string, unknown>> {
    this.trace.push('hydrate');
    this.opts.hydrateCalls.push([...ids]);
    const out = new Map<string, unknown>();
    for (const id of ids) {
      const raw = this.opts.raws[id];
      if (raw !== undefined) out.set(id, raw); // miss → omit (404)
    }
    return out;
  }

  protected toCanonical(raw: unknown): Email | null {
    const r = raw as RawMsg;
    if (r.subject === null) return null; // undecodable → drop
    return { id: r.id, subject: r.subject };
  }

  protected matchesRef(ref: Ref<EmailMeta>, filter?: EmailFilter): boolean {
    if (filter?.unreadOnly) return ref.meta.unread;
    return true;
  }
}

function ref(id: string, cursor: unknown, unread = false): Ref<EmailMeta> {
  return { externalId: id, cursor, meta: { unread } };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

// ---------------------------------------------------------------------------
// read() — drain + pairing + per-ref cursor
// ---------------------------------------------------------------------------

describe('IncrementalReadBase.read', () => {
  it('drains enumerate pages and yields one SourcedRecord per kept ref with the per-ref cursor', async () => {
    const hydrateCalls: string[][] = [];
    const src = new TestEmailRead({
      pages: [
        [ref('a', 'c-a'), ref('b', 'c-b')],
        [ref('c', 'c-c')],
      ],
      raws: {
        a: { id: 'a', subject: 'A' },
        b: { id: 'b', subject: 'B' },
        c: { id: 'c', subject: 'C' },
      },
      hydrateCalls,
    });

    const out = await collect(src.read({ mode: { kind: 'full' } }));

    expect(out).toEqual([
      { externalId: 'a', record: { id: 'a', subject: 'A' }, raw: { id: 'a', subject: 'A' }, cursor: 'c-a' },
      { externalId: 'b', record: { id: 'b', subject: 'B' }, raw: { id: 'b', subject: 'B' }, cursor: 'c-b' },
      { externalId: 'c', record: { id: 'c', subject: 'C' }, raw: { id: 'c', subject: 'C' }, cursor: 'c-c' },
    ]);
    // one hydrate per page
    expect(hydrateCalls).toEqual([['a', 'b'], ['c']]);
  });

  it('FILTERS BEFORE HYDRATE — a ref rejected by matchesRef is never hydrated', async () => {
    const hydrateCalls: string[][] = [];
    const src = new TestEmailRead({
      pages: [[ref('a', 'c-a', true), ref('b', 'c-b', false), ref('c', 'c-c', true)]],
      raws: {
        a: { id: 'a', subject: 'A' },
        b: { id: 'b', subject: 'B' },
        c: { id: 'c', subject: 'C' },
      },
      hydrateCalls,
    });

    const out = await collect(src.read({ mode: { kind: 'full' }, filter: { unreadOnly: true } }));

    expect(out.map((r) => r.externalId)).toEqual(['a', 'c']);
    // 'b' (read) was filtered pre-hydrate — hydrate only saw the kept ids
    expect(hydrateCalls).toEqual([['a', 'c']]);
  });

  it('skips a page entirely (no hydrate call) when every ref is filtered out', async () => {
    const hydrateCalls: string[][] = [];
    const src = new TestEmailRead({
      pages: [[ref('a', 'c-a', false), ref('b', 'c-b', false)]],
      raws: { a: { id: 'a', subject: 'A' }, b: { id: 'b', subject: 'B' } },
      hydrateCalls,
    });

    const out = await collect(src.read({ mode: { kind: 'full' }, filter: { unreadOnly: true } }));

    expect(out).toEqual([]);
    expect(hydrateCalls).toEqual([]); // no hydrate when nothing kept
  });

  it('is miss-tolerant — a hydrate miss is skipped without shifting alignment', async () => {
    const hydrateCalls: string[][] = [];
    const src = new TestEmailRead({
      pages: [[ref('a', 'c-a'), ref('gone', 'c-gone'), ref('c', 'c-c')]],
      // 'gone' deliberately absent from raws → deleted mid-run
      raws: { a: { id: 'a', subject: 'A' }, c: { id: 'c', subject: 'C' } },
      hydrateCalls,
    });

    const out = await collect(src.read({ mode: { kind: 'full' } }));

    expect(out.map((r) => r.externalId)).toEqual(['a', 'c']);
    expect(out.map((r) => r.cursor)).toEqual(['c-a', 'c-c']); // 'c' still paired to its own cursor
  });

  it('drops a record when toCanonical returns null', async () => {
    const hydrateCalls: string[][] = [];
    const src = new TestEmailRead({
      pages: [[ref('a', 'c-a'), ref('bad', 'c-bad')]],
      raws: { a: { id: 'a', subject: 'A' }, bad: { id: 'bad', subject: null } },
      hydrateCalls,
    });

    const out = await collect(src.read({ mode: { kind: 'full' } }));
    expect(out.map((r) => r.externalId)).toEqual(['a']);
  });

  it('applies matchesRecord as the post-hydrate floor', async () => {
    const hydrateCalls: string[][] = [];
    class PostFilterRead extends TestEmailRead {
      protected override matchesRecord(record: Email, filter?: EmailFilter): boolean {
        // post-hydrate predicate: subject must start with the requested letter
        return filter ? record.subject.startsWith('A') : true;
      }
    }
    const src = new PostFilterRead({
      pages: [[ref('a', 'c-a'), ref('b', 'c-b')]],
      raws: { a: { id: 'a', subject: 'Apple' }, b: { id: 'b', subject: 'Banana' } },
      hydrateCalls,
    });

    const out = await collect(src.read({ mode: { kind: 'full' }, filter: { unreadOnly: false } }));
    expect(out.map((r) => r.externalId)).toEqual(['a']);
    // both were hydrated (matchesRecord is post-hydrate)
    expect(hydrateCalls).toEqual([['a', 'b']]);
  });

  it('threads ReadRequest.pageSize through to enumerate', async () => {
    const src = new TestEmailRead({
      pages: [[ref('a', 'c-a')]],
      raws: { a: { id: 'a', subject: 'A' } },
      hydrateCalls: [],
    });
    await collect(src.read({ mode: { kind: 'full' }, pageSize: 250 }));
    expect(src.lastPageSize).toBe(250);
  });

  it('is LAZY — page N is hydrated before page N+1 is pulled (backpressure)', async () => {
    const hydrateCalls: string[][] = [];
    const src = new TestEmailRead({
      pages: [[ref('a', 'c-a')], [ref('b', 'c-b')]],
      raws: { a: { id: 'a', subject: 'A' }, b: { id: 'b', subject: 'B' } },
      hydrateCalls,
    });

    await collect(src.read({ mode: { kind: 'full' } }));
    // enumerate page 0 pulled → hydrated → THEN page 1 pulled → hydrated
    expect(src.trace).toEqual(['enum:0', 'hydrate', 'enum:1', 'hydrate']);
  });
});

// ---------------------------------------------------------------------------
// get() — RandomRead provided for free
// ---------------------------------------------------------------------------

describe('IncrementalReadBase.get (RandomRead)', () => {
  it('returns toCanonical(hydrate([id]))', async () => {
    const hydrateCalls: string[][] = [];
    const src = new TestEmailRead({
      pages: [],
      raws: { a: { id: 'a', subject: 'A' } },
      hydrateCalls,
    });
    expect(await src.get('a')).toEqual({ id: 'a', subject: 'A' });
    expect(hydrateCalls).toEqual([['a']]);
  });

  it('returns null on a hydrate miss', async () => {
    const src = new TestEmailRead({ pages: [], raws: {}, hydrateCalls: [] });
    expect(await src.get('nope')).toBeNull();
  });

  it('returns null when toCanonical rejects the payload', async () => {
    const src = new TestEmailRead({
      pages: [],
      raws: { bad: { id: 'bad', subject: null } },
      hydrateCalls: [],
    });
    expect(await src.get('bad')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listChanges() — IChangeSource adaptation
// ---------------------------------------------------------------------------

describe('IncrementalReadBase.listChanges', () => {
  it('maps a null cursor to full mode and stamps Change<T>', async () => {
    const src = new TestEmailRead({
      pages: [[ref('a', 'c-a')]],
      raws: { a: { id: 'a', subject: 'A' } },
      hydrateCalls: [],
    });

    const out = await collect(src.listChanges(subscription, null));
    expect(src.lastMode).toEqual({ kind: 'full' });
    expect(out).toEqual([
      {
        externalId: 'a',
        operation: 'updated',
        record: { id: 'a', subject: 'A' },
        cursor: 'c-a',
        source: 'poll',
      },
    ]);
  });

  it('maps a non-null cursor to delta mode carrying that cursor', async () => {
    const src = new TestEmailRead({
      pages: [[ref('b', 'c-b')]],
      raws: { b: { id: 'b', subject: 'B' } },
      hydrateCalls: [],
    });

    await collect(src.listChanges(subscription, 'cursor-77'));
    expect(src.lastMode).toEqual({ kind: 'delta', cursor: 'cursor-77' });
  });

  it('honors an overridden changeSource provenance', async () => {
    class CdcRead extends TestEmailRead {
      protected override readonly changeSource = 'cdc' as const;
    }
    const src = new CdcRead({
      pages: [[ref('a', 'c-a')]],
      raws: { a: { id: 'a', subject: 'A' } },
      hydrateCalls: [],
    });
    const [change] = await collect(src.listChanges(subscription, null));
    expect(change!.source).toBe('cdc');
  });
});

// ---------------------------------------------------------------------------
// listChanges() — cursor divisibility gating (RFC-0003 §3, R2)
// ---------------------------------------------------------------------------

/** Atomic-cursor source (Gmail historyId / Calendar syncToken profile). */
class AtomicEmailRead extends TestEmailRead {
  protected override readonly cursorDivisible = false;
}

describe('IncrementalReadBase.listChanges — cursor divisibility', () => {
  it('divisible (default): every Change carries its own per-ref cursor', async () => {
    const src = new TestEmailRead({
      pages: [[ref('a', 'c-a'), ref('b', 'c-b')], [ref('c', 'c-c')]],
      raws: {
        a: { id: 'a', subject: 'A' },
        b: { id: 'b', subject: 'B' },
        c: { id: 'c', subject: 'C' },
      },
      hydrateCalls: [],
    });
    const out = await collect(src.listChanges(subscription, null));
    expect(out.map((c) => c.cursor)).toEqual(['c-a', 'c-b', 'c-c']);
  });

  it('atomic: withholds every per-ref cursor except the final (end-of-walk) token', async () => {
    const src = new AtomicEmailRead({
      pages: [[ref('a', 'tok-mid-1'), ref('b', 'tok-mid-2')], [ref('c', 'tok-END')]],
      raws: {
        a: { id: 'a', subject: 'A' },
        b: { id: 'b', subject: 'B' },
        c: { id: 'c', subject: 'C' },
      },
      hydrateCalls: [],
    });
    const out = await collect(src.listChanges(subscription, 'prior-token'));

    // records still all delivered, in order
    expect(out.map((c) => c.externalId)).toEqual(['a', 'b', 'c']);
    // but only the LAST carries a real cursor — the rest are withheld so the
    // orchestrator (skip-null-cursor) can never persist a mid-walk token
    expect(out.map((c) => c.cursor)).toEqual([undefined, undefined, 'tok-END']);
  });

  it('atomic: a single-record walk carries the token on that record', async () => {
    const src = new AtomicEmailRead({
      pages: [[ref('only', 'tok-END')]],
      raws: { only: { id: 'only', subject: 'Only' } },
      hydrateCalls: [],
    });
    const out = await collect(src.listChanges(subscription, 'prior'));
    expect(out).toHaveLength(1);
    expect(out[0]!.cursor).toBe('tok-END');
  });

  it('atomic: an empty walk persists no cursor (re-reads next run, no data loss)', async () => {
    const src = new AtomicEmailRead({ pages: [[]], raws: {}, hydrateCalls: [] });
    const out = await collect(src.listChanges(subscription, 'prior'));
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Filter falsifier (RFC-0003 §8): a conforming adapter emits ONLY records
// matching the request filter — whether the filter is pushed down (matchesRef,
// pre-hydrate) or applied at the post-hydrate floor (matchesRecord). The
// emitted SET is identical; only the hydration cost differs.
// ---------------------------------------------------------------------------

describe('IncrementalReadBase — filter falsifier (§8)', () => {
  // Dataset rigged so "unread" (ref meta) ≡ "subject starts with A" (record),
  // so the SAME logical filter applied pre- vs post-hydrate must yield the same set.
  const pages = (): Ref<EmailMeta>[][] => [
    [
      ref('a', 'c-a', true), // Apple   — keep
      ref('b', 'c-b', false), // Banana  — drop
      ref('c', 'c-c', true), // Avocado — keep
      ref('d', 'c-d', false), // Berry   — drop
    ],
  ];
  const raws = {
    a: { id: 'a', subject: 'Apple' },
    b: { id: 'b', subject: 'Banana' },
    c: { id: 'c', subject: 'Avocado' },
    d: { id: 'd', subject: 'Berry' },
  };
  const MATCHING = ['a', 'c'];

  it('pushdown (matchesRef, pre-hydrate): emits ONLY the matching set, and never hydrates a dropped ref', async () => {
    const hydrateCalls: string[][] = [];
    const src = new TestEmailRead({ pages: pages(), raws, hydrateCalls });
    const out = await collect(
      src.read({ mode: { kind: 'full' }, filter: { unreadOnly: true } }),
    );
    expect(out.map((r) => r.externalId)).toEqual(MATCHING);
    // structural win: the dropped refs were filtered BEFORE hydrate.
    expect(hydrateCalls).toEqual([MATCHING]);
  });

  it('floor (matchesRecord, post-hydrate): emits the IDENTICAL set — hydrates all, then drops', async () => {
    class FloorEmailRead extends TestEmailRead {
      // no-pushdown floor: predicate can only be evaluated on the hydrated record
      protected override matchesRecord(rec: Email): boolean {
        return rec.subject.startsWith('A');
      }
    }
    const hydrateCalls: string[][] = [];
    const src = new FloorEmailRead({ pages: pages(), raws, hydrateCalls });
    const out = await collect(src.read({ mode: { kind: 'full' }, filter: {} }));
    // SAME emitted set as the pushdown case — the falsifier's core guarantee.
    expect(out.map((r) => r.externalId)).toEqual(MATCHING);
    // the cost of no pushdown: every ref was hydrated before the floor dropped it.
    expect(hydrateCalls).toEqual([['a', 'b', 'c', 'd']]);
  });
});

// ---------------------------------------------------------------------------
// mapConcurrent
// ---------------------------------------------------------------------------

describe('mapConcurrent', () => {
  it('collects results keyed by id', async () => {
    const out = await mapConcurrent(['a', 'b', 'c'], async (id) => id.toUpperCase(), 2);
    expect(out.get('a')).toBe('A');
    expect(out.get('b')).toBe('B');
    expect(out.get('c')).toBe('C');
    expect(out.size).toBe(3);
  });

  it('returns an empty map and runs nothing for empty input', async () => {
    let calls = 0;
    const out = await mapConcurrent([], async () => { calls++; return 1; }, 4);
    expect(out.size).toBe(0);
    expect(calls).toBe(0);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const ids = ['1', '2', '3', '4', '5', '6', '7'];
    await mapConcurrent(
      ids,
      async (id) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return id;
      },
      3,
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('caps width at ids.length when limit exceeds it', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapConcurrent(
      ['a', 'b'],
      async (id) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return id;
      },
      10,
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});
