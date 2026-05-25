---
to: "<%= architecture === 'clean-lite-ps' && exposeOnParent.left ? parentServicePathLeft : '' %>"
inject: true
before: "// Inherited from"
skip_if: "<%= injectionMarkerLeft %>"
---

  // ═══════════════════════════════════════════════════════════════════════
  // CGP-60 — fan-out to <%= rightEntityPascal %> (junction: <%= name %>)
  // Delegates to <%= classNames.service %>. Per-junction marker keeps
  // idempotency; multiple junctions on the same parent each emit their own
  // block. `forwardRef` resolves the circular module import (parent module
  // imports junction module; junction module imports parent modules for
  // repo DI).
  // ═══════════════════════════════════════════════════════════════════════
  <%= injectionMarkerLeft %>

  @Inject(forwardRef(() => <%= classNames.service %>))
  private readonly <%= entityNameCamel %>Service!: <%= classNames.service %>;

  async attach<%= rightEntityPascal %>(
    <%= leftEntityCamel %>Id: string,
    <%= rightEntityCamel %>Id: string,
    link?: <%= entityNamePascal %>LinkInput,
  ): Promise<<%= entityNamePascal %>> {
    return this.<%= entityNameCamel %>Service.attach(<%= leftEntityCamel %>Id, <%= rightEntityCamel %>Id, link);
  }

  async detach<%= rightEntityPascal %>(
    <%= leftEntityCamel %>Id: string,
    <%= rightEntityCamel %>Id: string,
  ): Promise<void> {
    return this.<%= entityNameCamel %>Service.detach(<%= leftEntityCamel %>Id, <%= rightEntityCamel %>Id);
  }

  async <%= rightEntityPlural %>List(
    <%= leftEntityCamel %>Id: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<Array<{ entity: <%= rightEntityPascal %>; link: <%= entityNamePascal %> }>> {
    return this.<%= entityNameCamel %>Service.listAssoc('left', <%= leftEntityCamel %>Id, opts) as Promise<
      Array<{ entity: <%= rightEntityPascal %>; link: <%= entityNamePascal %> }>
    >;
  }

  async <%= rightEntityPlural %>SetPrimary(
    <%= leftEntityCamel %>Id: string,
    <%= rightEntityCamel %>Id: string,
  ): Promise<void> {
    return this.<%= entityNameCamel %>Service.setPrimary(<%= leftEntityCamel %>Id, <%= rightEntityCamel %>Id);
  }

