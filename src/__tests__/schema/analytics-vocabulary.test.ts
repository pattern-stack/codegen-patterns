/**
 * SEM-1 — the analytics field tags and the entity-level composite metric
 * catalog (docs/specs/SEM-1.md, ADR-045).
 *
 * The pre-SEM-1 vocabulary (`measure`, `analytics_aggregation`,
 * `dimension_type`, `measure_packs`, `cube_name`, …) was parse-only and is
 * REPLACED, not aliased — so the removed keys must be rejected by name, and
 * every rule F1–F7 / E1–E2 has a passing and a failing case here.
 */

import { describe, it, expect } from 'bun:test';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';

const entityBlock = {
  entity: { name: 'opportunity', plural: 'opportunities', table: 'opportunities' },
};

/** An entity with one field, whose analytics tags the test supplies. */
function withField(field: Record<string, unknown>) {
  return { ...entityBlock, fields: { amount: { type: 'decimal', ...field } } };
}

/** Message text of the first issue, for asserting WHICH rule fired. */
function firstMessage(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.error!.issues[0]!.message;
}

// ---------------------------------------------------------------------------
// Field tags — the happy shapes
// ---------------------------------------------------------------------------

describe('SEM-1 field tags — accepted shapes', () => {
  it('accepts a measure with an allowed-aggregation set', () => {
    const r = EntityDefinitionSchema.safeParse(
      withField({ role: 'measure', aggs: ['sum', 'avg', 'min', 'max'], additivity: 'additive' }),
    );
    expect(r.success).toBe(true);
    expect(r.data!.fields.amount!.aggs).toEqual(['sum', 'avg', 'min', 'max']);
    expect(r.data!.fields.amount!.additivity).toBe('additive');
  });

  it('accepts a measure with a single aggregation', () => {
    const r = EntityDefinitionSchema.safeParse(
      withField({ role: 'measure', agg: 'avg', additivity: 'non' }),
    );
    expect(r.success).toBe(true);
    expect(r.data!.fields.amount!.agg).toBe('avg');
  });

  it('accepts a bare dimension', () => {
    const r = EntityDefinitionSchema.safeParse(
      { ...entityBlock, fields: { stage: { type: 'enum', choices: ['open'], role: 'dimension' } } },
    );
    expect(r.success).toBe(true);
    expect(r.data!.fields.stage!.role).toBe('dimension');
  });

  it('accepts time: true on a temporal dimension', () => {
    const r = EntityDefinitionSchema.safeParse(
      { ...entityBlock, fields: { closed_at: { type: 'datetime', role: 'dimension', time: true } } },
    );
    expect(r.success).toBe(true);
    expect(r.data!.fields.closed_at!.time).toBe(true);
  });

  it('leaves every tag undefined on an untagged field', () => {
    const r = EntityDefinitionSchema.safeParse(withField({}));
    expect(r.success).toBe(true);
    const f = r.data!.fields.amount!;
    expect([f.role, f.agg, f.aggs, f.additivity, f.time]).toEqual([
      undefined, undefined, undefined, undefined, undefined,
    ]);
  });

  it('narrows the aggregation vocabulary to the six the semantic layer knows', () => {
    for (const agg of ['count', 'count_distinct', 'sum', 'avg', 'min', 'max']) {
      const r = EntityDefinitionSchema.safeParse(
        withField({ role: 'measure', agg, additivity: 'additive' }),
      );
      expect(r.success).toBe(true);
    }
    // The pre-SEM-1 cube vocabulary had four more; they have no equivalent.
    for (const agg of ['average', 'median', 'percentile', 'sum_boolean']) {
      const r = EntityDefinitionSchema.safeParse(
        withField({ role: 'measure', agg, additivity: 'additive' }),
      );
      expect(r.success).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Field tags — rules F1–F7
// ---------------------------------------------------------------------------

describe('SEM-1 field tags — validation rules', () => {
  it('F1: a measure requires agg or aggs', () => {
    const r = EntityDefinitionSchema.safeParse(
      withField({ role: 'measure', additivity: 'additive' }),
    );
    expect(r.success).toBe(false);
    expect(firstMessage(r)).toContain("requires an aggregation");
  });

  it('F2: a measure requires additivity', () => {
    const r = EntityDefinitionSchema.safeParse(withField({ role: 'measure', agg: 'sum' }));
    expect(r.success).toBe(false);
    expect(firstMessage(r)).toContain("requires 'additivity'");
  });

  it('F3: agg and aggs are mutually exclusive', () => {
    const r = EntityDefinitionSchema.safeParse(
      withField({ role: 'measure', agg: 'sum', aggs: ['sum'], additivity: 'additive' }),
    );
    expect(r.success).toBe(false);
    expect(firstMessage(r)).toContain('mutually exclusive');
  });

  it('F4: aggs must be non-empty', () => {
    const r = EntityDefinitionSchema.safeParse(
      withField({ role: 'measure', aggs: [], additivity: 'additive' }),
    );
    expect(r.success).toBe(false);
    expect(firstMessage(r)).toContain('at least one aggregation');
  });

  it('F4: aggs must not repeat an aggregation', () => {
    const r = EntityDefinitionSchema.safeParse(
      withField({ role: 'measure', aggs: ['sum', 'sum'], additivity: 'additive' }),
    );
    expect(r.success).toBe(false);
    expect(firstMessage(r)).toContain('must not repeat');
  });

  it('F5: aggregation config on a dimension is rejected', () => {
    const r = EntityDefinitionSchema.safeParse(
      withField({ role: 'dimension', agg: 'sum', additivity: 'additive' }),
    );
    expect(r.success).toBe(false);
    expect(firstMessage(r)).toContain("requires 'role: measure'");
    // Each dangling key is reported at its own path, not at `role`.
    const paths = r.error!.issues.map((i) => i.path.at(-1));
    expect(paths).toEqual(['agg', 'additivity']);
  });

  it('F5: additivity without a role is rejected', () => {
    const r = EntityDefinitionSchema.safeParse(withField({ additivity: 'additive' }));
    expect(r.success).toBe(false);
    expect(firstMessage(r)).toContain("'additivity' is measure configuration");
    expect(r.error!.issues[0].path.at(-1)).toBe('additivity');
  });

  it('F6: time: true requires a temporal field type', () => {
    const r = EntityDefinitionSchema.safeParse(withField({ role: 'dimension', time: true }));
    expect(r.success).toBe(false);
    expect(firstMessage(r)).toContain('temporal field type');
  });

  it('F6: both date and datetime are temporal', () => {
    for (const type of ['date', 'datetime']) {
      const r = EntityDefinitionSchema.safeParse(
        { ...entityBlock, fields: { at: { type, role: 'dimension', time: true } } },
      );
      expect(r.success).toBe(true);
    }
  });

  it('F7: time: true on a measure is rejected', () => {
    const r = EntityDefinitionSchema.safeParse(
      { ...entityBlock, fields: {
        closed_at: { type: 'datetime', role: 'measure', agg: 'max', additivity: 'non', time: true },
      } },
    );
    expect(r.success).toBe(false);
    expect(firstMessage(r)).toContain('not that axis');
  });
});

// ---------------------------------------------------------------------------
// The removed vocabulary (I7 — replaced, not aliased or stripped)
// ---------------------------------------------------------------------------

describe('SEM-1 — the pre-SEM-1 vocabulary is gone, loudly', () => {
  const removedFieldKeys: Record<string, unknown> = {
    measure: true,
    analytics_aggregation: 'sum',
    agg_time_dimension: 'closed_at',
    non_additive_dimension: 'closed_at',
    dimension: true,
    dimension_type: 'categorical',
    time_granularity: 'day',
    is_partition: true,
    entity: true,
    entity_type: 'primary',
    entity_role: 'owner',
    analytics_visibility: 'internal',
    semantic_expr: 'amount * 2',
    semantic_label: 'Amount',
  };

  for (const [key, value] of Object.entries(removedFieldKeys)) {
    it(`rejects the removed field key '${key}' by name rather than stripping it`, () => {
      const r = EntityDefinitionSchema.safeParse(withField({ [key]: value }));
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error!.issues)).toContain(key);
    });
  }

  it('rejects the removed entity-level keys measure_packs and cube_name', () => {
    for (const block of [{ measure_packs: ['monetary'] }, { cube_name: 'Opportunities' }]) {
      const r = EntityDefinitionSchema.safeParse({ ...withField({}), analytics: block });
      expect(r.success).toBe(false);
    }
  });

  it("rejects the removed 'simple' metric type — a simple metric is a measure-tagged field", () => {
    const r = EntityDefinitionSchema.safeParse({
      ...withField({ role: 'measure', agg: 'sum', additivity: 'additive' }),
      analytics: { metrics: { total: { type: 'simple', measure: 'amount', agg: 'sum' } } },
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Entity-level metrics
// ---------------------------------------------------------------------------

const measureField = { type: 'decimal', role: 'measure', aggs: ['sum'], additivity: 'additive' };

function withMetrics(metrics: Record<string, unknown>) {
  return { ...entityBlock, fields: { amount: measureField }, analytics: { metrics } };
}

describe('SEM-1 analytics.metrics — composite kinds', () => {
  it('accepts a ratio', () => {
    const r = EntityDefinitionSchema.safeParse(
      withMetrics({ win_rate: { type: 'ratio', numerator: 'won.sum', denominator: 'amount.sum', label: 'Win rate' } }),
    );
    expect(r.success).toBe(true);
  });

  it('accepts a derived metric whose expr is a tree', () => {
    const r = EntityDefinitionSchema.safeParse(
      withMetrics({
        gross_profit: {
          type: 'derived',
          expr: { op: '-', left: { ref: 'revenue.sum' }, right: { ref: 'cost.sum' } },
        },
      }),
    );
    expect(r.success).toBe(true);
  });

  it('accepts a literal weight inside a derived expression', () => {
    const r = EntityDefinitionSchema.safeParse(
      withMetrics({
        weighted: { type: 'derived', expr: { op: '*', left: { ref: 'amount.sum' }, right: { lit: 0.5 } } },
      }),
    );
    expect(r.success).toBe(true);
  });

  it('accepts a cumulative metric with an optional partition', () => {
    const r = EntityDefinitionSchema.safeParse(
      withMetrics({
        running: { type: 'cumulative', measure: 'amount.sum', order_by: 'created_at', partition_by: 'account_id' },
      }),
    );
    expect(r.success).toBe(true);
  });

  it('E1: a derived expression with no measure reference is rejected', () => {
    const r = EntityDefinitionSchema.safeParse(
      withMetrics({ nonsense: { type: 'derived', expr: { op: '+', left: { lit: 1 }, right: { lit: 2 } } } }),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toContain('at least one measure');
  });

  it('E2: a non-finite literal is rejected', () => {
    const r = EntityDefinitionSchema.safeParse(
      withMetrics({ bad: { type: 'derived', expr: { op: '*', left: { ref: 'amount.sum' }, right: { lit: Infinity } } } }),
    );
    expect(r.success).toBe(false);
  });

  it('E2: an operator outside the closed four is rejected', () => {
    const r = EntityDefinitionSchema.safeParse(
      withMetrics({ bad: { type: 'derived', expr: { op: '^', left: { ref: 'a.sum' }, right: { lit: 2 } } } }),
    );
    expect(r.success).toBe(false);
  });

  it('E2: an operator node missing an operand is rejected', () => {
    const r = EntityDefinitionSchema.safeParse(
      withMetrics({ bad: { type: 'derived', expr: { op: '+', left: { ref: 'a.sum' } } } }),
    );
    expect(r.success).toBe(false);
  });

  it('rejects a cumulative metric without order_by', () => {
    const r = EntityDefinitionSchema.safeParse(
      withMetrics({ running: { type: 'cumulative', measure: 'amount.sum' } }),
    );
    expect(r.success).toBe(false);
  });

  it('rejects an unknown key inside a metric', () => {
    const r = EntityDefinitionSchema.safeParse(
      withMetrics({ win_rate: { type: 'ratio', numerator: 'a', denominator: 'b', filter: "stage = 'won'" } }),
    );
    expect(r.success).toBe(false);
  });

  it('rejects an unknown key inside the analytics block', () => {
    const r = EntityDefinitionSchema.safeParse({
      ...withField({}),
      analytics: { metrics: {}, cubes: ['Opportunities'] },
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Strictness — an undeclared field key is an author error
// ---------------------------------------------------------------------------

describe('SEM-1 — FieldDefinitionSchema is strict', () => {
  it('rejects a misspelled tag rather than silently dropping it', () => {
    const r = EntityDefinitionSchema.safeParse(
      withField({ role: 'measure', agg: 'sum', additivity: 'additive', additivty: 'non' }),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toContain('additivty');
  });

  it('still accepts every declared non-analytics key', () => {
    const r = EntityDefinitionSchema.safeParse({
      ...entityBlock,
      fields: {
        name: {
          type: 'string', required: true, nullable: false, max_length: 120, min_length: 1,
          index: true, unique: true, default: 'x',
          ui_label: 'Name', ui_type: 'text', ui_importance: 'primary', ui_group: 'core',
          ui_sortable: true, ui_filterable: true, ui_visible: true, ui_placeholder: 'p',
          ui_help: 'h', ui_format: {}, ui_key_field: true, ui_key_field_order: 1,
        },
      },
    });
    expect(r.success).toBe(true);
  });
});
