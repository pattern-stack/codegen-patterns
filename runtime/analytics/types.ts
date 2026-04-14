/**
 * Semantic type definitions for the analytics layer.
 *
 * These types mirror MetricFlow / dbt-semantic-interfaces enums but are
 * defined locally so consumers don't need the full dependency for basic
 * field configuration. When the cube.js backend is used, these values
 * map 1:1 to cube measure/dimension types.
 */

// ============================================================================
// Enums
// ============================================================================

export enum AggregationType {
  SUM = 'sum',
  MIN = 'min',
  MAX = 'max',
  COUNT = 'count',
  COUNT_DISTINCT = 'count_distinct',
  AVERAGE = 'average',
  MEDIAN = 'median',
  PERCENTILE = 'percentile',
  SUM_BOOLEAN = 'sum_boolean',
}

export enum DimensionType {
  CATEGORICAL = 'categorical',
  TIME = 'time',
}

export enum EntityType {
  PRIMARY = 'primary',
  UNIQUE = 'unique',
  FOREIGN = 'foreign',
  NATURAL = 'natural',
}

export enum MetricType {
  SIMPLE = 'simple',
  DERIVED = 'derived',
  RATIO = 'ratio',
  CUMULATIVE = 'cumulative',
  CONVERSION = 'conversion',
}

/**
 * Time granularity for time dimensions.
 *
 * Sub-day granularities (hour, minute, second) are intentionally omitted
 * because cube.js does not support them.
 */
export enum TimeGranularity {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
  QUARTER = 'quarter',
  YEAR = 'year',
}

// ============================================================================
// Config interfaces
// ============================================================================

/**
 * Configuration for non-additive dimensions on measures.
 *
 * Non-additive dimensions specify that a measure cannot be summed across
 * certain dimensions. For example, inventory balances cannot be summed
 * across time — you need the latest value, not the sum.
 */
export interface NonAdditiveDimensionConfig {
  name: string;
  window_choice?: AggregationType;
  window_groupings?: string[];
}

/**
 * Complete semantic configuration for a field.
 *
 * Used to store all semantic metadata on a field definition for later
 * extraction by the manifest builder / cube schema generator.
 */
export interface SemanticFieldConfig {
  // Measure configuration
  measure?: boolean;
  agg?: AggregationType;
  agg_time_dimension?: string;
  non_additive_dimension?: NonAdditiveDimensionConfig;

  // Dimension configuration
  dimension?: boolean;
  dimension_type?: DimensionType;
  time_granularity?: TimeGranularity;
  is_partition?: boolean;

  // Entity configuration
  entity?: boolean;
  entity_type?: EntityType;
  entity_role?: string;

  // Common
  semantic_expr?: string;
  semantic_label?: string;
  visibility?: 'internal' | 'agent' | 'public';
}
