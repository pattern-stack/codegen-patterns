---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.repository : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
import { Injectable, Inject } from '@nestjs/common';
<% if (hasDeclarativeQueries) { -%>
import { eq<%= hasMultiFieldQuery ? ', and' : '' %><%= hasOrderedQuery ? ', desc, asc' : '' %> } from 'drizzle-orm';
<% } -%>
<% if (eavValueTable) { -%>
import { sql } from 'drizzle-orm';
<% } -%>
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient<% if (eavValueTable) { %>, DrizzleTx<% } %> } from '@shared/types/drizzle';
import { <%= repositoryBaseClass %> } from '<%= repositoryBaseImport %>';
<% if (hasTimestamps || hasSoftDelete || hasUserTracking) { -%>
import type { BehaviorConfig } from '@shared/base-classes/base-repository';
<% } -%>
import { <%= entityNamePlural %>, type <%= classNames.entity %> } from './<%= entityName %>.entity';

@Injectable()
export class <%= classNames.repository %> extends <%= repositoryBaseClass %><<%= classNames.entity %>> {
  readonly table = <%= entityNamePlural %>;
<% if (hasTimestamps || hasSoftDelete || hasUserTracking) { -%>

  // Behaviors declared in YAML -> generated as config object
  protected override readonly behaviors: BehaviorConfig = {
    timestamps: <%= !!hasTimestamps %>,
    softDelete: <%= !!hasSoftDelete %>,
    userTracking: <%= !!hasUserTracking %>,
  };
<% } -%>
<% if (hasPatternConfig) { -%>

  // Per-entity `<%= patternName %>` pattern config (from YAML `config:` block).
  // The pattern's base class declares `protected readonly patternConfig: TConfig`
  // typed via its `configSchema`; this concrete record is read by the base at
  // runtime (identical shape to `behaviors: BehaviorConfig`).
  protected override readonly patternConfig = <%- renderPatternConfigLiteral(patternConfig, '  ', '  ') %> as const;
<% } -%>

  constructor(@Inject(DRIZZLE) db: DrizzleClient) {
    super(db);
  }
<% if (hasDeclarativeQueries) { -%>

  // ═══════════════════════════════════════════════════════════════════════
  // Declarative queries (from queries: block in entity YAML)
  // ═══════════════════════════════════════════════════════════════════════
<%_ processedQueries.forEach((q) => { _%>

  async <%= q.methodName %>(<%- q.params.map(p => `${p.camelName}: ${p.tsType}`).join(', ') %>): Promise<<%- q.returnType %>> {
<% if (q.isUnique) { -%>
    const rows = await this.baseQuery()
      .where(<%- q.hasMultipleParams ? 'and(' : '' %><%- q.params.map(p => `eq(this.table['${p.camelName}'], ${p.camelName})`).join(', ') %><%- q.hasMultipleParams ? ')' : '' %>)
      .limit(1);
    return (rows[0] as <%= classNames.entity %>) ?? null;
<% } else { -%>
    const rows = await this.baseQuery()
      .where(<%- q.hasMultipleParams ? 'and(' : '' %><%- q.params.map(p => `eq(this.table['${p.camelName}'], ${p.camelName})`).join(', ') %><%- q.hasMultipleParams ? ')' : '' %>)<%- q.hasOrder ? `.orderBy(${q.orderDirection}(this.table['${q.orderBy}']))` : '' %>;
    return rows as <%= classNames.entity %>[];
<% } -%>
  }
<%_ }) _%>
<% } else { -%>

  // TODO: Add entity-specific query methods here.
<% } -%>
<% if (eavValueTable) { -%>

  // ═══════════════════════════════════════════════════════════════════════
  // EAV compound writes (task #23) — generated from eav_value_table: true
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Upsert "current" value rows keyed by the composite unique
   * (entity_type, entity_id, field_definition_id). Used by the service's
   * upsertFieldsTransactional to dual-write a bag of dynamic fields
   * atomically with the owning entity. Inherited upsertMany only
   * supports single-column conflict targets — this override uses
   * Drizzle's `onConflictDoUpdate` with an explicit column list.
   */
  async upsertCurrentValues(
    inputs: Array<Partial<<%= classNames.entity %>>>,
    tx?: DrizzleTx,
  ): Promise<<%= classNames.entity %>[]> {
    if (inputs.length === 0) return [];
    const data = inputs.map((input) =>
      this.withTimestamps(input as Record<string, unknown>, 'create'),
    );
    const runner = this.runner(tx);
    const rows = await runner
      .insert(this.table)
      .values(data as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      .onConflictDoUpdate({
        target: [
          this.table['entityType'],
          this.table['entityId'],
          this.table['fieldDefinitionId'],
        ],
        set: {
          value: sql`excluded.value`,
          userId: sql`excluded.user_id`,
          updatedAt: sql`excluded.updated_at`,
        } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      })
      .returning();
    return rows as <%= classNames.entity %>[];
  }
<% } -%>

  // Inherited from <%= repositoryBaseClass %>:
<%_ repositoryInheritedMethods.forEach(line => { _%>
  //   <%= line %>
<%_ }) _%>
}
