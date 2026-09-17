/**
 * Semantic-model cross-validator (SEM-1)
 *
 * Runs after `loadEntities()` over the full entity set. Field-level and
 * structural rules live in the Zod schema (they are per-file); everything
 * here needs the whole set, because the emitted measure catalog is one flat
 * namespace shared by every entity:
 *
 *   • atomic measure keys must be unique across entities;
 *   • every `ratio` leg, `derived` {ref} and `cumulative` measure must name a
 *     declared atomic measure;
 *   • metric names must be unique across entities and must not collide with a
 *     derived atomic key;
 *   • `cumulative.order_by` / `partition_by` must be fields on the entity that
 *     owns the accumulated measure — that is the entity the window runs over.
 *
 * Mirrors `validate-emits.ts` (EVT-7): pure, framework-agnostic, never throws.
 * The CLI surfaces the issues.
 */

import type {
	AnalysisIssue,
	DerivedExpr,
	MetricDefinition,
	ParsedEntity,
} from '../analyzer/types.js';

/**
 * One derived atomic measure: the catalog key plus where it came from.
 */
export interface AtomicMeasureKey {
	/** Catalog key — `<field>.<agg>` when `aggs:` was declared, else `<field>`. */
	key: string;
	/** Entity that declares the field. */
	entity: string;
	/** Field name on that entity. */
	field: string;
}

/**
 * Derive the atomic measure catalog keys from the field tags.
 *
 * This is the consuming semantic layer's own rule, applied here so a metric
 * leg can be resolved before anything is emitted: a `role: measure` field
 * declaring `aggs` yields one key per agg (`amount.sum`, `amount.avg`); a
 * field declaring the single `agg` yields the bare field name.
 *
 * Exported because SEM-2's emitter and any fixture must spell legs the same
 * way — the derivation is declared once, here.
 */
export function deriveAtomicMeasureKeys(entity: ParsedEntity): AtomicMeasureKey[] {
	const keys: AtomicMeasureKey[] = [];
	for (const [fieldName, field] of entity.fields) {
		const { role, agg, aggs } = field.analytics;
		if (role !== 'measure') continue;
		if (aggs !== undefined) {
			for (const a of aggs) {
				keys.push({ key: `${fieldName}.${a}`, entity: entity.name, field: fieldName });
			}
		} else if (agg !== undefined) {
			keys.push({ key: fieldName, entity: entity.name, field: fieldName });
		}
	}
	return keys;
}

/** Collect every `{ref}` in a derived metric's expression tree. */
function collectExprRefs(node: DerivedExpr, out: string[] = []): string[] {
	if ('ref' in node) out.push(node.ref);
	else if ('op' in node) {
		collectExprRefs(node.left, out);
		collectExprRefs(node.right, out);
	}
	return out;
}

/** The measure names a metric depends on, with the YAML path of each. */
function metricLegs(metric: MetricDefinition): Array<{ leg: string; path: string }> {
	switch (metric.type) {
		case 'ratio':
			return [
				{ leg: metric.numerator, path: 'numerator' },
				{ leg: metric.denominator, path: 'denominator' },
			];
		case 'derived':
			return collectExprRefs(metric.expr).map((leg) => ({ leg, path: 'expr' }));
		case 'cumulative':
			return [{ leg: metric.measure, path: 'measure' }];
		default:
			return [];
	}
}

/** `a.sum, b` — the declared keys, for an error message. Capped so it stays readable. */
function describeKnown(keys: Iterable<string>): string {
	const all = [...keys].sort();
	if (all.length === 0) return 'no measures are declared anywhere — tag a field with `role: measure`';
	const shown = all.slice(0, 12).join(', ');
	return all.length > 12 ? `${shown}, … (${all.length} total)` : shown;
}

/**
 * Cross-validate the declared semantic model.
 *
 * `allEntities` supplies the catalog (legs may point at another entity);
 * `targets` selects whose metrics are checked — the `entity new` pre-flight
 * validates only the entities it is about to generate, while `analyzeDomain`
 * validates everything.
 */
export function validateSemanticModel(
	allEntities: ParsedEntity[],
	targets: ParsedEntity[] = allEntities,
): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];
	const targetNames = new Set(targets.map((e) => e.name));
	// A namespace collision is a whole-model defect, but `entity new` should
	// only refuse to generate over one that involves what it is generating —
	// otherwise an unrelated pair of entities blocks every command. With the
	// default `targets = allEntities` (analyzeDomain) nothing is filtered.
	const involvesTarget = (...names: string[]) => names.some((n) => targetNames.has(n));

	// --- atomic catalog, with ambiguity detection (C1) -----------------------
	const atomicOwner = new Map<string, AtomicMeasureKey>();
	for (const entity of allEntities) {
		for (const atomic of deriveAtomicMeasureKeys(entity)) {
			const existing = atomicOwner.get(atomic.key);
			if (existing && existing.entity !== atomic.entity) {
				if (!involvesTarget(existing.entity, atomic.entity)) continue;
				issues.push({
					severity: 'error',
					type: 'ambiguous_measure',
					entity: atomic.entity,
					field: atomic.field,
					message: `Measure '${atomic.key}' is declared on both '${existing.entity}' and '${atomic.entity}'. Measure keys share one catalog namespace and must be unique across entities.`,
					path: entity.sourcePath,
					suggestion: `Rename one of the two fields, or narrow its 'aggs:' so the keys differ.`,
				});
				continue;
			}
			atomicOwner.set(atomic.key, atomic);
		}
	}

	// --- metric names: unique across entities (C3), no atomic collision (C4) --
	const metricOwner = new Map<string, string>();
	for (const entity of allEntities) {
		for (const name of Object.keys(entity.analytics?.metrics ?? {})) {
			const existing = metricOwner.get(name);
			if (existing) {
				if (involvesTarget(existing, entity.name)) {
					issues.push({
						severity: 'error',
						type: 'duplicate_metric',
						entity: entity.name,
						message: `Metric '${name}' is declared on both '${existing}' and '${entity.name}'. Metrics share one catalog namespace and must be unique across entities.`,
						path: entity.sourcePath,
					});
				}
				continue;
			}
			metricOwner.set(name, entity.name);

			const atomic = atomicOwner.get(name);
			if (atomic && involvesTarget(entity.name, atomic.entity)) {
				issues.push({
					severity: 'error',
					type: 'metric_name_collision',
					entity: entity.name,
					message: `Metric '${name}' collides with the measure '${name}' derived from field '${atomic.field}' on '${atomic.entity}'. Metrics and measures share one catalog namespace.`,
					path: entity.sourcePath,
				});
			}
		}
	}

	// --- leg resolution (C2) and cumulative window columns (C5) --------------
	const entityByName = new Map(allEntities.map((e) => [e.name, e]));

	for (const entity of targets) {
		const metrics = entity.analytics?.metrics;
		if (!metrics) continue;

		for (const [name, metric] of Object.entries(metrics)) {
			for (const { leg, path } of metricLegs(metric)) {
				if (atomicOwner.has(leg)) continue;
				issues.push({
					severity: 'error',
					type: 'unresolved_measure',
					entity: entity.name,
					message: `Metric '${name}' (${path}) references measure '${leg}', which no entity declares. Declared measures: ${describeKnown(atomicOwner.keys())}.`,
					path: entity.sourcePath,
					suggestion: `A measure key is '<field>.<agg>' when the field declares 'aggs:', or '<field>' when it declares a single 'agg:'.`,
				});
			}

			if (metric.type !== 'cumulative') continue;

			// C5 — the running total runs over the entity owning the measure.
			const owner = atomicOwner.get(metric.measure);
			if (!owner) continue; // already reported by C2
			const ownerEntity = entityByName.get(owner.entity);
			if (!ownerEntity) continue;

			for (const [key, column] of [
				['order_by', metric.order_by],
				['partition_by', metric.partition_by],
			] as const) {
				if (column === undefined) continue;
				if (ownerEntity.fields.has(column)) continue;
				issues.push({
					severity: 'error',
					type: 'unresolved_window_column',
					entity: entity.name,
					field: column,
					message: `Cumulative metric '${name}' (${key}: '${column}') must name a field on '${owner.entity}', the entity declaring measure '${metric.measure}'. '${owner.entity}' has no field '${column}'.`,
					path: entity.sourcePath,
				});
			}
		}
	}

	return issues;
}
