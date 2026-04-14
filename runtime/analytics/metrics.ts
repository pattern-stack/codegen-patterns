/**
 * Metric composition types for the analytics layer.
 *
 * Ported from the Python reference (pattern_stack/atoms/semantic/metrics.py).
 * These interfaces describe the four metric types that can be declared on
 * entity YAML specs and compiled into cube.js metric definitions.
 */

import type { AggregationType, TimeGranularity } from './types';

// ============================================================================
// Metric interfaces
// ============================================================================

/**
 * A simple metric based on a single measure.
 *
 * Example:
 *   { type: 'simple', measure: 'amount' }
 *   { type: 'simple', measure: 'amount', agg: 'count', filter: "status = 'completed'" }
 */
export interface SimpleMetric {
  type: 'simple';
  measure: string;
  agg?: AggregationType;
  filter?: string;
  description?: string;
  label?: string;
}

/**
 * A derived metric computed from an expression over other metrics.
 *
 * Example:
 *   { type: 'derived', expr: 'total_revenue / order_count', metrics: ['total_revenue', 'order_count'] }
 */
export interface DerivedMetric {
  type: 'derived';
  expr: string;
  metrics: string[];
  description?: string;
  label?: string;
}

/**
 * A ratio metric computing numerator / denominator.
 *
 * Example:
 *   { type: 'ratio', numerator: 'won_deals', denominator: 'total_deals' }
 */
export interface RatioMetric {
  type: 'ratio';
  numerator: string | SimpleMetric;
  denominator: string | SimpleMetric;
  filter?: string;
  description?: string;
  label?: string;
}

/**
 * A cumulative metric for time-series accumulation.
 *
 * Specify either window OR grain_to_date, not both.
 *
 * Example:
 *   { type: 'cumulative', measure: 'revenue', window: '28 days' }
 *   { type: 'cumulative', measure: 'order_count', grain_to_date: 'month' }
 */
export interface CumulativeMetric {
  type: 'cumulative';
  measure: string;
  window?: string;
  grain_to_date?: TimeGranularity;
  description?: string;
  label?: string;
}

/**
 * Union type of all metric definitions.
 */
export type MetricDefinition =
  | SimpleMetric
  | DerivedMetric
  | RatioMetric
  | CumulativeMetric;
