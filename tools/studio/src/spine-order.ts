/**
 * The spine-order toggle (STUDIO-6) — the pure half: the header's options and
 * the remembered choice. The rule itself lives in one place, `graph/spine.ts`;
 * this file only names the two orders and remembers which one the reader picked.
 */
import { DEFAULT_SPINE_ORDER } from './graph/spine';
import type { SpineOrder } from './graph/spine';

/** The header's segmented control: each order, and what it ranks first. */
export const SPINE_ORDER_OPTIONS: readonly { id: SpineOrder; label: string; title: string }[] = [
  {
    id: 'inheritance-first',
    label: 'Inheritance',
    title: 'Spine: inherits, then on_delete: cascade, then first declared — a child hangs under its base',
  },
  {
    id: 'ownership-first',
    label: 'Ownership',
    title: 'Spine: on_delete: cascade, then inherits, then first declared — a child hangs under its owner',
  },
];

// ── Remembered order ─────────────────────────────────────────────────────────

/** Per viewer, per browser. */
export const SPINE_ORDER_STORAGE_KEY = 'studio.spineOrder';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function isSpineOrder(value: unknown): value is SpineOrder {
  return SPINE_ORDER_OPTIONS.some((option) => option.id === value);
}

/** The stored order; storage absent, throwing or holding anything else reads as inheritance first. */
export function loadSpineOrder(storage: () => StorageLike | undefined): SpineOrder {
  try {
    const stored = storage()?.getItem(SPINE_ORDER_STORAGE_KEY);
    return isSpineOrder(stored) ? stored : DEFAULT_SPINE_ORDER;
  } catch {
    return DEFAULT_SPINE_ORDER;
  }
}

export function storeSpineOrder(storage: () => StorageLike | undefined, order: SpineOrder): void {
  try {
    storage()?.setItem(SPINE_ORDER_STORAGE_KEY, order);
  } catch {
    // Remembering is a convenience; the order still applies to this page.
  }
}
