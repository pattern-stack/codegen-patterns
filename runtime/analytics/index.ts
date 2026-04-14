/**
 * Analytics layer — public API
 *
 * Re-exports types, metrics, specs, and measure packs.
 */
export {
  AggregationType,
  DimensionType,
  EntityType,
  MetricType,
  TimeGranularity,
} from './types';
export type {
  NonAdditiveDimensionConfig,
  SemanticFieldConfig,
} from './types';
export type {
  SimpleMetric,
  DerivedMetric,
  RatioMetric,
  CumulativeMetric,
  MetricDefinition,
} from './metrics';
export type {
  MeasureSpec,
  DimensionSpec,
  EntitySpec,
  SemanticModelSpec,
} from './specs';
export type { MonetaryMeasures } from './packs/monetary-measures';
export type { CrmEntityMeasures } from './packs/crm-entity-measures';
