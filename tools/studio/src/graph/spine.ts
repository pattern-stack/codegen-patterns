/**
 * The spine rule (STUDIO-3) — which of a node's parents it hangs under in the
 * tree. Every node has at most one SPINE parent; each of its other foreign keys
 * is a SECONDARY line, drawn lighter and never fed to the layout.
 *
 * First match wins, in the reader's chosen order (STUDIO-6, `SpineOrder`):
 *
 *   inheritance first (the default)      ownership first
 *   1. `inherits:`                        1. `on_delete: cascade`
 *   2. `on_delete: cascade`               2. `inherits:`
 *   3. first declared                     3. first declared
 *
 * - `inherits:` (#875, RFC-0006) — a child hangs under its base. Fed by `buildEdges` from
 *   `SerializedEntity.inherits`, not from a `belongs_to`. It replaced the unique-FK tier (a 1:1 `belongs_to`
 *   standing in for "is a"): STUDIO-3 recorded that when #875 landed that inference would be deleted, no shim,
 *   and it was — `inherits:` is how an is-a is stated.
 * - `on_delete: cascade` — an owning `belongs_to`: the child dies with its parent.
 * - the first declared `belongs_to`.
 * Within a tier, the first declared wins. The two orders differ only in which of the first two tiers ranks
 * higher; ownership first lets a child that inherits a shared base hang under the parent that owns it.
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
  /** `on_delete: cascade` (`SerializedRelationship.onDelete`). */
  cascade: boolean;
}

export const NO_SIGNALS: SpineSignals = { inherits: false, cascade: false };

/** A line that could be a node's spine: the child holds an FK onto the parent. */
export interface SpineCandidate {
  edgeId: string;
  child: string;
  parent: string;
  /** Declaration order among the child's candidates — the tie-break. */
  order: number;
  signals: SpineSignals;
}

export type SpineTier = 'inherits' | 'cascade' | 'first-declared';

/** Which tier outranks which (STUDIO-6). The reader picks one in the header. */
export type SpineOrder = 'inheritance-first' | 'ownership-first';

export const DEFAULT_SPINE_ORDER: SpineOrder = 'inheritance-first';

/** The tiers in the default (inheritance-first) order, each with the words the line shows for it. */
export const SPINE_TIERS: readonly { tier: SpineTier; reason: string; matches: (s: SpineSignals) => boolean }[] = [
  { tier: 'inherits', reason: 'inherits', matches: (s) => s.inherits },
  { tier: 'cascade', reason: 'on_delete: cascade', matches: (s) => s.cascade },
  { tier: 'first-declared', reason: 'first declared', matches: () => true },
];

/** Each order's tier ranking, best first. The one table both orders read; `first-declared` is last in both. */
export const SPINE_ORDERS: Record<SpineOrder, readonly SpineTier[]> = {
  'inheritance-first': ['inherits', 'cascade', 'first-declared'],
  'ownership-first': ['cascade', 'inherits', 'first-declared'],
};

export interface SpineChoice {
  edgeId: string;
  parent: string;
  tier: SpineTier;
  /** `spine: on_delete: cascade` — the words on the line. */
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

function matches(tier: SpineTier, signals: SpineSignals): boolean {
  return SPINE_TIERS.find((t) => t.tier === tier)!.matches(signals);
}

/** The best tier a candidate's signals reach under `order`. */
function tierOf(signals: SpineSignals, order: SpineOrder): SpineTier {
  return SPINE_ORDERS[order].find((tier) => matches(tier, signals))!;
}

function rank(tier: SpineTier, order: SpineOrder): number {
  return SPINE_ORDERS[order].indexOf(tier);
}

/**
 * Each child's spine, keyed by child id, under `order` (inheritance first unless the reader chose otherwise).
 *
 * Per child: the candidate in the best tier, then the first declared. Then the
 * forest is made a forest: a choice that closes a cycle (A's spine is B, B's
 * spine is A, or longer) is dropped, so that node is a root — the dropped one
 * is the cycle member whose choice is the weakest tier, then the last by id, so
 * the answer does not depend on the order the candidates arrive in.
 */
export function chooseSpines(
  candidates: readonly SpineCandidate[],
  order: SpineOrder = DEFAULT_SPINE_ORDER,
): Map<string, SpineChoice> {
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
      (a, b) => rank(tierOf(a.signals, order), order) - rank(tierOf(b.signals, order), order) || a.order - b.order,
    )[0]!;
    const tier = tierOf(best.signals, order);
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
      (a, b) => rank(chosen.get(b)!.tier, order) - rank(chosen.get(a)!.tier, order) || (a < b ? 1 : a > b ? -1 : 0),
    )[0]!;
    chosen.delete(drop);
  }

  return chosen;
}
