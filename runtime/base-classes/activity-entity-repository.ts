/**
 * ActivityEntityRepository<TEntity>
 *
 * Family-specific base for activity / interaction entities (emails, calls,
 * meetings, messages, transcripts). Adds date-range queries, actor (`user_id`)
 * scoping, recency ordering, and **config-driven subject scoping** — the
 * subject FK column is resolved from the concrete repo's `patternConfig`
 * (ADR-031 §4) rather than hardcoded, so the same base serves a CRM
 * `opportunity`-scoped activity and a swe-brain `person`-scoped interaction.
 *
 * Concrete repos extend this and declare their table + behaviors, and (when
 * they use the subject finders) a `patternConfig` carrying `subject` /
 * `subjectColumn` / `occurredAt`. The template emits that property from the
 * entity's `config: { Activity: {...} }` block. See ACTIVITY-SUBJECT-1.
 */
import { eq, between, desc } from 'drizzle-orm';
import { BaseRepository } from './base-repository';

/**
 * Per-entity Activity config (matches `ActivityPatternConfigSchema` in
 * `src/patterns/library/activity.pattern.ts`). Carried on the concrete repo as
 * `patternConfig` and read here to resolve column names at runtime.
 */
export interface ActivityPatternConfig {
  /** Subject entity name → derives the FK column `<subject>_id`. */
  subject?: string;
  /** Explicit snake_case FK column, when it does not follow `<subject>_id`. */
  subjectColumn?: string;
  /** snake_case recency-ordering column; defaults to `occurred_at`. */
  occurredAt?: string;
}

const toCamel = (snake: string): string =>
  snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export abstract class ActivityEntityRepository<TEntity> extends BaseRepository<TEntity> {
  /**
   * Per-entity Activity config. The template emits this from `config:
   * { Activity: {...} }`; entities that only use date-range / user scoping omit
   * it (and must not call the subject finders).
   */
  protected readonly patternConfig?: ActivityPatternConfig;

  /**
   * camelCase key for the recency-ordering column. Defaults to `occurredAt`
   * (column `occurred_at`); override via `patternConfig.occurredAt`.
   */
  protected get occurredAtColumn(): string {
    const snake = this.patternConfig?.occurredAt ?? 'occurred_at';
    return toCamel(snake);
  }

  /**
   * camelCase key for the subject FK column, resolved from `patternConfig`:
   * `subjectColumn` (explicit) → `<subject>_id` (derived). Throws when neither
   * is configured — the subject finders are unusable without it, and a clear
   * error beats a silent `undefined` column index.
   */
  protected get subjectColumn(): string {
    const explicit = this.patternConfig?.subjectColumn;
    if (explicit) return toCamel(explicit);
    const subject = this.patternConfig?.subject;
    if (subject) return toCamel(`${subject}_id`);
    throw new Error(
      'ActivityEntityRepository: subject finders require a subject column. ' +
        "Set `config: { Activity: { subject: '<entity>' } }` (→ <entity>_id) " +
        "or `config: { Activity: { subjectColumn: '<column>' } }` on the entity YAML.",
    );
  }

  /**
   * Find activities within a date range (inclusive), by the recency column.
   */
  async findByDateRange(start: Date, end: Date): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(between(this.table[this.occurredAtColumn], start, end));
    return rows as TEntity[];
  }

  /**
   * Find all activities for a specific user (actor / owner scoping).
   */
  async findByUserId(userId: string): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(eq(this.table['userId'], userId));
    return rows as TEntity[];
  }

  /**
   * Find all activities for a specific subject (config-driven FK column).
   */
  async findBySubjectId(subjectId: string): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(eq(this.table[this.subjectColumn], subjectId));
    return rows as TEntity[];
  }

  /**
   * Find the most recent activities for a subject, ordered by the recency
   * column descending.
   */
  async findRecentBySubjectId(subjectId: string, limit = 10): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(eq(this.table[this.subjectColumn], subjectId))
      .orderBy(desc(this.table[this.occurredAtColumn]))
      .limit(limit);
    return rows as TEntity[];
  }
}
