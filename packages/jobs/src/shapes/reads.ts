import { z } from 'zod';
import { defineShape } from './define-shape.ts';
import {
  RUN_PAGE_DEFAULT,
  RUN_PAGE_MAX,
  RUN_STATUSES,
  RUN_WAIT_DEFAULT_MS,
  RUN_WAIT_MAX_MS,
} from './vocabulary.ts';

export const runListQueryShape = defineShape(
  z.object({
    status: z.enum(RUN_STATUSES).optional(),
    limit: z.number().int().min(1).max(RUN_PAGE_MAX).default(RUN_PAGE_DEFAULT),
    cursor: z
      .string()
      .max(512)
      .optional()
      .describe(
        "The previous page's meta.nextCursor, with the same status; omit for the first page",
      ),
  }),
);

export const runWaitQueryShape = defineShape(
  z.object({
    after: z
      .string()
      .max(64)
      .optional()
      .describe(
        'The revision you hold; default: the run as this call first reads it',
      ),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .max(RUN_WAIT_MAX_MS)
      .default(RUN_WAIT_DEFAULT_MS)
      .describe('How long to hold before answering the run unchanged'),
  }),
);
