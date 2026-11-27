import { z } from 'zod';
import type { ItemRef, ItemStatus } from '../model/item.ts';
import type { StepStatus } from '../model/step-state.ts';

/** Ids per section a view may name: what one opened section can sensibly show. */
export const ITEM_VIEW_REF_IDS_MAX = 50;

/**
 * The domain records a view's section names: a ref kind (the host's list, e.g. `observation`; the core doesn't know
 * them) and their ids.
 */
export const itemViewRefsSchema = z.object({
  kind: z.string().min(1).max(64),
  ids: z.array(z.string().min(1).max(255)).min(1).max(ITEM_VIEW_REF_IDS_MAX),
});

export type ItemViewRefs = z.infer<typeof itemViewRefsSchema>;

/**
 * How one map item reads on a run page: a label, a one-line summary and the detail an opened item shows. Declared by
 * the job (`mapStep({ present })`), computed at read time, never stored: changing a presenter changes what past runs
 * show. Text only: whatever it says comes from the item's stored result.
 */
export const itemViewSchema = z.object({
  /** The row's name, e.g. "GTCR · email". */
  label: z.string().min(1).max(200),
  /** The row's one line, e.g. "→ netsuite, sap_concur". */
  summary: z.string().max(500).optional(),
  /**
   * An opened item's sections: a heading, its text, the evidence as a quote, and the domain records it names (`refs`).
   */
  detail: z
    .array(
      z.object({
        heading: z.string().max(200),
        text: z.string().max(2000).optional(),
        quote: z.string().max(4000).optional(),
        /**
         * Domain records the section shows by id, e.g. the observations an extracted artifact wrote: `{ kind:
         * 'observation', ids }`. The result keeps the ids, never the records; the host looks them up when the page
         * reads the view, in the run's tenant, through the source its owning context registered for the kind
         * (`@pattern-stack/jobs/nest`), so the page shows each record as it is now. An id the tenant doesn't hold, or a
         * kind with no source, shows as not found.
         */
        refs: itemViewRefsSchema.optional(),
      }),
    )
    .max(100)
    .optional(),
});

export type ItemView = z.infer<typeof itemViewSchema>;

/** What a presenter reads: one item as stored. */
export interface ItemViewInput<R> {
  /** The planned ref, an entity id. */
  ref: ItemRef;
  /** The item's key. */
  key: string;
  status: ItemStatus;
  /** The stored result, parsed by the step's result schema when it has one; null when there is none. */
  result: R | null;
  /** A failed item's last error; null otherwise. */
  error: { kind: string; message: string } | null;
}

/**
 * A map step's presenter: pure and synchronous, with no ctx and no I/O, so whatever the label needs must be in the
 * result. It never enters the definition version: it is presentation, and changing it never strands a run. A reader
 * that gets no presenter, a throw or an answer `itemViewSchema` refuses falls back to the item's key.
 */
export type ItemPresenter<R> = (item: ItemViewInput<R>) => ItemView;

/**
 * How a plain step reads on a run page: the Steps row's one line and the detail its expanded row shows, above its stored
 * output. Declared by the job (`step({ present })`), computed at read time, never stored, as an item's view is.
 */
export const stepViewSchema = z.object({
  /** Rarely needed: the row is the step's name. */
  label: z.string().min(1).max(200).optional(),
  /** The row's one line, e.g. "88 to ask of 88 in the Signal · est. $0.09". */
  summary: z.string().min(1).max(300),
  /** The expanded step's sections, the same `{ heading, text?, quote? }` as an item's. */
  detail: itemViewSchema.shape.detail,
});

export type StepView = z.infer<typeof stepViewSchema>;

/** What a step presenter reads: one plain step as stored. */
export interface StepViewInput<O> {
  /** The stored output; null before the step completes. */
  output: O | null;
  status: StepStatus;
  /** A failed step's error; null otherwise. */
  error: { kind: string; message: string } | null;
}

/**
 * A plain step's presenter: pure and synchronous, with no ctx and no I/O, never in the definition version, run at read
 * time. Null: no view. A reader that gets no presenter, a throw or an answer `stepViewSchema` refuses shows no summary,
 * and the stored output still.
 */
export type StepPresenter<O> = (step: StepViewInput<O>) => StepView | null;
