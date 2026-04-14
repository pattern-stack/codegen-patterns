/**
 * Intermediate spec types for the analytics layer.
 *
 * Ported from the Python reference (pattern_stack/atoms/semantic/manifest.py).
 * These interfaces are the intermediate representation used when extracting
 * semantic metadata from entity YAML and converting it into cube.js schema.
 */

import type { AggregationType, DimensionType, EntityType, NonAdditiveDimensionConfig, TimeGranularity } from './types';
import type { MetricDefinition } from './metrics';

// ============================================================================
// Spec interfaces
// ============================================================================

export interface MeasureSpec {
  name: string;
  agg: AggregationType;
  expr?: string;
  agg_time_dimension?: string;
  non_additive_dimension?: NonAdditiveDimensionConfig;
  description?: string;
  label?: string;
}

export interface DimensionSpec {
  name: string;
  dimension_type: DimensionType;
  expr?: string;
  time_granularity?: TimeGranularity;
  is_partition?: boolean;
  description?: string;
  label?: string;
}

export interface EntitySpec {
  name: string;
  entity_type: EntityType;
  expr?: string;
  role?: string;
  description?: string;
  label?: string;
}

export interface SemanticModelSpec {
  name: string;
  table_name: string;
  measures: MeasureSpec[];
  dimensions: DimensionSpec[];
  entities: EntitySpec[];
  metrics: MetricDefinition[];
  primary_entity?: string;
  default_agg_time_dimension?: string;
}
