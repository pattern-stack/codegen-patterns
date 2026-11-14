/**
 * The spine rule (STUDIO-3) — which of a node's parents it hangs under in the
 * tree. Every node has at most one SPINE parent; each of its other foreign keys
 * is a SECONDARY line, drawn lighter and never fed to the layout.
 *
 * First match wins:
 *   1. an explicit `inherits:` (#875, RFC-0006) — a child hangs under its base.
 *      Fed by `buildEdges` from `SerializedEntity.inherits`, not from a `belongs_to`.
 *      The tiers below stay: a plain unique-FK 1:1 is still a modelling choice
 *      that is not an inheritance, and `inherits:` is what states one.
 *   2. a `belongs_to` whose FK column is unique (the 1:1 is-a workaround);
 *   3. a `belongs_to` with `on_delete: cascade`;
 *   4. the first declared `belongs_to`.
 * Within a tier, the first declared wins.
 *
 * A self-reference is never a spine (a node cannot hang under itself), and a
 * choice that would close a cycle of spines is dropped — see `chooseSpines`.
 *
 * Pure: no React, no DOM. Unit-tested in `../__tests__/spine.test.ts`.
 */

/** What a candidate edge says about itself, read off the graph payload. */
export interface SpineSignals {
  /** An explicit `inherits:` (#875): set only on the child → base edge `buildEdges` draws for it. */
  inherits: boolean;
  /** The FK column is unique (`SerializedRelationship.fkUnique`). */
  fkUnique: boolean;
  /** `on_delete: cascade` (`SerializedRelationship.onDelete`). */
  cascade: boolean;
}

export const NO_SIGNALS: SpineSignals = { inherits: false, fkUnique: false, cascade: false };

/** A line that could be a node's spine: the child holds an FK onto the parent. */
export interface SpineCandidate {
  edgeId: string;
  child: string;
  parent: string;
  /** Declaration order among the child's candidates — the tie-break. */
  order: number;
  signals: SpineSignals;
}

export type SpineTier = 'inherits' | 'unique-fk' | 'cascade' | 'first-declared';

/** The tiers in rule order, each with the words the line shows for it. */
export const SPINE_TIERS: readonly { tier: SpineTier; reason: string; matches: (s: SpineSignals) => boolean }[] = [
  { tier: 'inherits', reason: 'inherits', matches: (s) => s.inherits },
  { tier: 'unique-fk', reason: 'unique FK (1:1)', matches: (s) => s.fkUnique },
  { tier: 'cascade', reason: 'on_delete: cascade', matches: (s) => s.cascade },
  { tier: 'first-declared', reason: 'first declared', matches: () => true },
];

export interface SpineChoice {
  edgeId: string;
  parent: string;
  tier: SpineTier;
  /** `spine: unique FK (1:1)` — the words on the line. */
  reason: string;
}

/** The text a spine line shows: `spine: <tier reason>`. */
export function spineReason(tier: SpineTier): string {
  return `spine: ${SPINE_TIERS.find((t) => t.tier === tier)!.reason}`;
}

/** The text a secondary line shows: whose spine it is not, and which one is. */
export function secondaryReason(child: string, spine: SpineChoice | undefined): string {
  return spine == null
    ? `secondary: ${child} has no spine`
    : `secondary: ${child}'s spine is ${spine.parent} (${spine.reason.replace(/^spine: /, '')})`;
}

function tierOf(signals: SpineSignals): SpineTier {
  return SPINE_TIERS.find((t) => t.matches(signals))!.tier;
}

function rank(tier: SpineTier): number {
  return SPINE_TIERS.findIndex((t) => t.tier === tier);
}

/**
 * Each child's spine, keyed by child id.
 *
 * Per child: the candidate in the best tier, then the first declared. Then the
 * forest is made a forest: a choice that closes a cycle (A's spine is B, B's
 * spine is A, or longer) is dropped, so that node is a root — the dropped one
 * is the cycle member whose choice is the weakest tier, then the last by id, so
 * the answer does not depend on the order the candidates arrive in.
 */
export function chooseSpines(candidates: readonly SpineCandidate[]): Map<string, SpineChoice> {
  const byChild = new Map<string, SpineCandidate[]>();
  for (const c of candidates) {
    if (c.child === c.parent) continue;
    const list = byChild.get(c.child) ?? [];
    list.push(c);
    byChild.set(c.child, list);
  }

  const chosen = new Map<string, SpineChoice>();
  for (const [child, list] of byChild) {
    const best = [...list].sort(
      (a, b) => rank(tierOf(a.signals)) - rank(tierOf(b.signals)) || a.order - b.order,
    )[0]!;
    const tier = tierOf(best.signals);
    chosen.set(child, { edgeId: best.edgeId, parent: best.parent, tier, reason: spineReason(tier) });
  }

  // Break cycles. Visiting children in id order keeps this deterministic.
  for (const start of [...chosen.keys()].sort()) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let node: string | undefined = start;
    while (node != null && chosen.has(node) && !onPath.has(node)) {
      path.push(node);
      onPath.add(node);
      node = chosen.get(node)!.parent;
    }
    if (node == null || !onPath.has(node)) continue;
    const cycle = path.slice(path.indexOf(node));
    const drop = [...cycle].sort(
      (a, b) => rank(chosen.get(b)!.tier) - rank(chosen.get(a)!.tier) || (a < b ? 1 : a > b ? -1 : 0),
    )[0]!;
    chosen.delete(drop);
  }

  return chosen;
}
