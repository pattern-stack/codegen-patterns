---
to: "<%= architecture === 'clean-lite-ps' && exposeOnParent.right ? parentServicePathRight : '' %>"
inject: true
before: "// Inherited from"
skip_if: "<%= injectionMarkerRight %>"
---

  // ═══════════════════════════════════════════════════════════════════════
  // CGP-60 — fan-out to <%= leftEntityPascal %> (junction: <%= name %>)
  // Delegates to <%= classNames.service %>. See left-side block for the
  // forwardRef + per-junction marker rationale.
  // ═══════════════════════════════════════════════════════════════════════
  <%= injectionMarkerRight %>

  @Inject(forwardRef(() => <%= classNames.service %>))
  private readonly <%= entityNameCamel %>Service!: <%= classNames.service %>;

  async addTo<%= leftEntityPascal %>(
    <%= rightEntityCamel %>Id: string,
    <%= leftEntityCamel %>Id: string,
    link?: <%= entityNamePascal %>LinkInput,
  ): Promise<<%= entityNamePascal %>> {
    return this.<%= entityNameCamel %>Service.attach(<%= leftEntityCamel %>Id, <%= rightEntityCamel %>Id, link);
  }

  async removeFrom<%= leftEntityPascal %>(
    <%= rightEntityCamel %>Id: string,
    <%= leftEntityCamel %>Id: string,
  ): Promise<void> {
    return this.<%= entityNameCamel %>Service.detach(<%= leftEntityCamel %>Id, <%= rightEntityCamel %>Id);
  }

  async <%= leftEntityPlural %>List(
    <%= rightEntityCamel %>Id: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<Array<{ entity: <%= leftEntityPascal %>; link: <%= entityNamePascal %> }>> {
    return this.<%= entityNameCamel %>Service.listAssoc('right', <%= rightEntityCamel %>Id, opts) as Promise<
      Array<{ entity: <%= leftEntityPascal %>; link: <%= entityNamePascal %> }>
    >;
  }

  async <%= leftEntityPlural %>SetPrimary(
    <%= rightEntityCamel %>Id: string,
    <%= leftEntityCamel %>Id: string,
  ): Promise<void> {
    return this.<%= entityNameCamel %>Service.setPrimary(<%= leftEntityCamel %>Id, <%= rightEntityCamel %>Id);
  }

