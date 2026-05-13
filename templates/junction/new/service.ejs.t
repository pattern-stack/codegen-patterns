---
to: "<%= outputPaths.service %>"
force: true
---
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { <%= classNames.repository %> } from './<%= name %>.repository';
import type { <%= classNames.entity %> } from './<%= name %>.entity';

@Injectable()
export class <%= classNames.service %> extends WithAnalytics(
  BaseService<<%= classNames.repository %>, <%= classNames.entity %>>,
) {
  protected override readonly entityName = '<%= name %>';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(protected override readonly repository: <%= classNames.repository %>) {
    super(repository);
  }

  // Pairing-aware pass-throughs — mirror the repo's two finders so use-cases
  // and #60's fan-out methods both delegate through the service layer, keeping
  // analytics/events instrumentation uniform (per relationship's service.ejs.t).

  /**
   * Fetch all junction rows for a given <%= leftColumn %>.
   *
   * FIXME: align with codegen-patterns#358 pagination shape if it diverges.
   */
  async findBy<%= leftEntityPascal %>Id(
    <%= leftColumnCamel %>: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<<%= classNames.entity %>[]> {
    return this.repository.findBy<%= leftEntityPascal %>Id(<%= leftColumnCamel %>, opts);
  }

  /**
   * Fetch all junction rows for a given <%= rightColumn %>.
   *
   * FIXME: align with codegen-patterns#358 pagination shape if it diverges.
   */
  async findBy<%= rightEntityPascal %>Id(
    <%= rightColumnCamel %>: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<<%= classNames.entity %>[]> {
    return this.repository.findBy<%= rightEntityPascal %>Id(<%= rightColumnCamel %>, opts);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Fan-out association methods (attach/detach/list/setPrimary) are NOT
  // emitted here. They land via junction-association-codegen
  // (pattern-stack/dealbrain-integrations#60) once
  // pattern-stack/codegen-patterns#358 establishes the service-method
  // emission machinery.
  //
  // Until #60 lands, consumers hand-write fan-out methods in their own
  // service files against the canonical shape documented in
  // .ai-docs/stacks/codegen-app-patterns/specs/cgp-62.md (see
  // architectural_notes.cross_entity_access.canonical_shape in the stack
  // plan). The hand-written methods are the executable spec for #60.
  // ─────────────────────────────────────────────────────────────────────────

  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete
}
