---
to: "<%= outputPaths.service %>"
force: true
---
<%- generatedBanner %>
import { Injectable, Inject, Optional<% if (junctionFanOut.length > 0) { %>, forwardRef<% } %> } from '@nestjs/common';
import { WithAnalytics } from '<%= withAnalyticsImport %>';
import { EVENT_BUS } from '<%= drizzleTokenImport %>';
import { <%= serviceBaseClass %> } from '<%= serviceBaseImport %>';
import { <%= classNames.repository %> } from './<%= entityFileStem %>.repository';
<%_
// READ-1 §7 — the service forwards the repository's read surface verbatim:
// the same generics, the same options, the same result.
const E = classNames.entity;
const _typedInclude = apiSurface.repository.typedInclude;
// RFC-0006 (#875) S3 — which family reads exist is the derivation's call (`with_base` / cross-kind entries).
const _child = apiSurface.service.methods.some((m) => m.kind === 'with_base');
const _ACROSS = ['all_kinds', 'kind_by_id', 'list_kind', 'count_kind'];
const _isAcross = (m) => _ACROSS.includes(m.kind);
const _base = apiSurface.service.methods.some(_isAcross);
const _readGenerics = _typedInclude
  ? `<W extends ${E}Include = ${E}NoInclude, C extends ${E}Columns | undefined = undefined>`
  : `<C extends ${E}Columns | undefined = undefined>`;
const _readArgs = _typedInclude ? '<W, C>' : '<C>';
const _readOpts = _typedInclude ? 'ReadOptions<W, C>' : 'ReadOptions<never, C>';
const _readResult = _typedInclude ? `${E}Result<W, C>` : `${E}Result<${E}NoInclude, C>`;
_%>
import type {
  <%= E %>Columns,
<% if (_child) { -%>
  <%= E %>Flat,
<% } -%>
<% if (_base) { -%>
  <%= E %>FlatByKind,
  <%= E %>Kind,
  <%= E %>OfKind,
<% } -%>
<% if (_typedInclude) { -%>
  <%= E %>Include,
<% } -%>
  <%= E %>NoInclude,
  <%= E %>Result,
} from './<%= entityFileStem %>.repository';
import type { ListOptions, ReadOptions<%= _base ? ', RowFilter' : '' %> } from '<%= baseRepositoryImport %>';
import type { <%= entityNamePlural %>, <%= classNames.entity %> } from './<%= entityFileStem %>.entity';
<% if (eavEnabled) { -%>
import { FieldValueService } from '<%= eavFieldValueImportDir %>/<%= eavFieldValueStem %>.service';
<% } -%>
<% if (eavValueTable) { -%>
import { toEavRows, mergeEavRows } from '<%= eavHelpersImport %>';
import type { DrizzleTx } from '<%= drizzleTypeImport %>';
<% if (!eavDefinitionRepositoryImported) { -%>
import { <%= eavDefinitionPascal %>Repository } from '<%= eavDefinitionImportDir %>/<%= eavDefinitionEntityStem %>.repository';
<% } -%>
<% } -%>
<%_ /* #632 — one import per composed repository (belongs_to + has_many targets, deduped) */ _%>
<%_ repositoryDeps.forEach(dep => { _%>
import { <%= dep.repositoryClass %> } from '<%= dep.importDir %>/<%= dep.fileStem %>.repository';
import type { <%= dep.entityClass %> } from '<%= dep.importDir %>/<%= dep.fileStem %>.entity';
<%_ }) _%>
<%_ /* JUNC-0 — each junction this entity is mirrored onto: its service, link + row types, and the counterparty type */ _%>
<%_ junctionFanOut.forEach(fan => { _%>
import { <%= fan.junction.serviceClass %>, <%= fan.junction.linkInputType %> } from '<%= fan.junctionServiceImport %>';
import type { <%= fan.junction.entityClass %> } from '<%= fan.junctionEntityImport %>';
<%_ if (fan.importCounterparty) { _%>
import type { <%= fan.counterpartyPascal %> } from '<%= fan.counterpartyEntityImport %>';
<%_ } _%>
<%_ }) _%>

@Injectable()
export class <%= classNames.service %> extends WithAnalytics(
  <%= serviceBaseClass %><<%= classNames.repository %>, <%= classNames.entity %>>,
) {
  protected override readonly entityName = '<%= entityName %>';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: <%= classNames.repository %>,
<% if (eavEnabled) { -%>
    private readonly fieldValues: FieldValueService,
<% } -%>
<% if (eavValueTable && !eavDefinitionRepositoryImported) { -%>
    private readonly definitionRepo: <%= eavDefinitionPascal %>Repository,
<% } -%>
<%_ /* #632 — one constructor parameter per composed repository */ _%>
<%_ repositoryDeps.forEach(dep => { _%>
    private readonly <%= dep.property %>: <%= dep.repositoryClass %>,
<%_ }) _%>
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(<%= classNames.service %>);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask<% if (_typedInclude) { %> and an allowlisted include<% } %> to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════
<%_
// ADR-046 — this template PRINTS the service's methods: one loop over the
// derivation's emitted `apiSurface.service.methods`, `m.kind` choosing the body.
// Every method name, parameter name and callee (`m.delegatesTo.method`) is
// printed, never built. A forwarder's body follows its callee's shape — the
// repository method it delegates to. The TS text beside the names comes from
// `queryTypes` / `relationTypes`, keyed by the derived name (PLAN §4.3).
const _methods = apiSurface.service.methods.filter((m) => m.emitted);
const _repoMethods = apiSurface.repository.methods;
const _calleeKind = (m) => {
  const callee = _repoMethods.find((r) => r.name === m.delegatesTo.method);
  return callee ? callee.kind : null;
};
// Sections: a banner opens each group of kinds; the read surface closes with the
// inherited-methods comment, the `queries:` forwarders with a blank line.
const _group = (m) =>
  m.kind.startsWith('junction_') ? 'junction'
  : m.kind === 'relation_one' || m.kind === 'relation_many' ? 'relation'
  : m.kind === 'eav_read' || m.kind === 'eav_write' ? 'eav'
  : m.kind === 'with_base' || _isAcross(m) || m.kind === 'orphans' ? 'read'
  : m.kind;
_%>
<%_ _methods.forEach((m, i) => { _%>
<%_ const _prev = i > 0 ? _group(_methods[i - 1]) : null; _%>
<%_ const _next = i + 1 < _methods.length ? _group(_methods[i + 1]) : null; _%>
<%_ const _first = _prev !== _group(m); _%>
<%_ const _last = _next !== _group(m); _%>
<%_ if (m.kind === 'read') { _%>
<%_ const _p = m.params[0].name; _%>
<%_ const _callee = _calleeKind(m); _%>
<%_ if (_callee === 'find_by_id') { _%>

  override <%= m.name %><%- _readGenerics %>(
    <%= _p %>: string,
    <%= m.params[1].name %>?: <%- _readOpts %>,
  ): Promise<<%- _readResult %> | null> {
    return this.repository.<%= m.delegatesTo.method %><%- _readArgs %>(<%= _p %>, <%= m.params[1].name %>);
  }
<%_ } else if (_callee === 'find_by_ids') { _%>

  override <%= m.name %><%- _readGenerics %>(
    <%= _p %>: readonly string[],
    <%= m.params[1].name %>?: <%- _readOpts %>,
  ): Promise<Array<<%- _readResult %>>> {
    return this.repository.<%= m.delegatesTo.method %><%- _readArgs %>(<%= _p %>, <%= m.params[1].name %>);
  }
<%_ } else { _%>

  override <%= m.name %><%- _readGenerics %>(
    <%= _p %>?: ListOptions<typeof <%= entityNamePlural %>> & <%- _readOpts %>,
  ): Promise<Array<<%- _readResult %>>> {
    return this.repository.<%= m.delegatesTo.method %><%- _readArgs %>(<%= _p %>);
  }
<%_ } _%>
<%_ } else if (m.kind === 'with_base' || _isAcross(m) || m.kind === 'orphans') { _%>
<%_ /* RFC-0006 (#875) §3 — the family reads, forwarded verbatim: the repository's names, params and result. */ _%>
<%_ const _p = m.params.map((x) => x.name); _%>
<%_ if (m.kind === 'with_base' && m.returns === 'one') { _%>

  // RFC-0006 §3.2 — the base row, flat: the repository's `findWithBase` / `findManyWithBase`, forwarded.
  <%= m.name %><W extends <%= E %>Include & { <%= familyChild.relKey %>?: never } = <%= E %>NoInclude, C extends <%= E %>Columns | undefined = undefined>(
    <%= _p[0] %>: string,
    <%= _p[1] %>?: ReadOptions<W, C>,
  ): Promise<<%= E %>Flat<W, C> | null> {
    return this.repository.<%= m.delegatesTo.method %><W, C>(<%= _p[0] %>, <%= _p[1] %>);
  }
<%_ } else if (m.kind === 'with_base') { _%>

  <%= m.name %><W extends <%= E %>Include & { <%= familyChild.relKey %>?: never } = <%= E %>NoInclude, C extends <%= E %>Columns | undefined = undefined>(
    <%= _p[0] %>: readonly string[],
    <%= _p[1] %>?: ReadOptions<W, C>,
  ): Promise<Array<<%= E %>Flat<W, C>>> {
    return this.repository.<%= m.delegatesTo.method %><W, C>(<%= _p[0] %>, <%= _p[1] %>);
  }
<%_ } else if (m.kind === 'orphans') { _%>

  <%= m.name %>(<%= _p[0] %>?: { limit?: number }): Promise<<%= E %>[]> {
    return this.repository.<%= m.delegatesTo.method %>(<%= _p[0] %>);
  }
<%_ } else { _%>
<%_ if (!_isAcross(_methods[i - 1])) { _%>

  // RFC-0006 §3.3 — reading across kinds: the repository's, forwarded.
<%_ } _%>
<%_ if (m.kind === 'all_kinds') { _%>
  <%= m.name %>(
    <%= _p[0] %>?: ListOptions<typeof <%= entityNamePlural %>> & { kinds?: readonly <%= E %>Kind[] },
  ): Promise<<%= E %>OfKind[]> {
    return this.repository.<%= m.delegatesTo.method %>(<%= _p[0] %>);
  }
<%_ } else if (m.kind === 'kind_by_id') { _%>

  <%= m.name %>(<%= _p[0] %>: string): Promise<<%= E %>OfKind | null> {
    return this.repository.<%= m.delegatesTo.method %>(<%= _p[0] %>);
  }
<%_ } else if (m.kind === 'list_kind') { _%>

  <%= m.name %><K extends keyof <%= E %>FlatByKind>(
    <%= _p[0] %>: K,
    <%= _p[1] %>?: ListOptions<typeof <%= entityNamePlural %>>,
  ): Promise<Array<<%= E %>FlatByKind[K]>> {
    return this.repository.<%= m.delegatesTo.method %><K>(<%= _p[0] %>, <%= _p[1] %>);
  }
<%_ } else { _%>

  <%= m.name %>(<%= _p[0] %>: <%= E %>Kind, <%= _p[1] %>?: RowFilter<typeof <%= entityNamePlural %>>): Promise<number> {
    return this.repository.<%= m.delegatesTo.method %>(<%= _p[0] %>, <%= _p[1] %>);
  }
<%_ } _%>
<%_ } _%>
<%_ } else if (m.kind === 'finder') { _%>
<%_ if (_first) { _%>
  // ═══════════════════════════════════════════════════════════════════════
  // Declarative queries (from queries: block in entity YAML)
  // Pass-through to repository — keeps use-cases on the service layer so
  // cross-cutting concerns (analytics, events) stay uniform.
  // ═══════════════════════════════════════════════════════════════════════
<%_ } _%>
<%_
// The `by:` columns are the parameters that bind a field; their TS types come
// from `queryTypes`, in the same order.
const _t = queryTypes[m.name];
const _cols = m.params.filter((p) => p.field !== undefined);
const _sig = _cols.map((p, i) => `${p.name}: ${_t.params[i].tsType}`).join(', ');
const _args = _cols.map((p) => p.name).join(', ');
_%>
<%_ if (_calleeKind(m) === 'finder_projection') { _%>

  async <%= m.name %>(<%- _sig %>): Promise<<%- _t.returnType %>> {
    return this.repository.<%= m.delegatesTo.method %>(<%= _args %>);
  }
<%_ } else { _%>
<%_ const _opts = m.params[m.params.length - 1].name; _%>

  <%= m.name %><%- _readGenerics %>(
    <%- _sig %>,
    <%= _opts %>?: <%- _readOpts %>,
  ): Promise<<%- m.returns === 'one' ? `${_readResult} | null` : `Array<${_readResult}>` %>> {
    return this.repository.<%= m.delegatesTo.method %><%- _readArgs %>(<%= _args %>, <%= _opts %>);
  }
<%_ } _%>
<%_ if (_last) { _%>

<%_ } _%>
<%_ } else if (m.kind === 'capability_forwarder') { _%>
<%_ /* ADR-041 — capability forwarders. A capability's methods live on the
      repository (its mixin put them there); the service exposes the vocabulary
      the capability declared in `forwarderMethods`. Signatures are derived from
      the repository method, never re-declared (charter I1), and the forwarder is
      deliberately NOT `async`: `ReturnType<…>` is whatever the capability
      method returns, and `async` would require it to be a Promise. */ _%>
<%_ if (_first) { _%>
  // ═══════════════════════════════════════════════════════════════════════
  // Capability forwarders (ADR-041)
  // Pass-through to the repository, where the capability's mixin lives.
  // ═══════════════════════════════════════════════════════════════════════
<%_ } _%>
<%_ const _callee = m.delegatesTo.method; _%>

  /** Contributed by the `<%= m.origin.capability %>` capability. */
  <%= m.name %>(
    <%= m.params[0].name %>: globalThis.Parameters<<%= classNames.repository %>['<%= _callee %>']>
  ): globalThis.ReturnType<<%= classNames.repository %>['<%= _callee %>']> {
    return this.repository.<%= _callee %>(<%= m.params[0].name %>);
  }
<%_ } else if (m.kind === 'relation_one' || m.kind === 'relation_many') { _%>
<%_ /* CGP-358b — service-layer composition methods for relationships. The
      repository a method reads is this entity's own (a self-reference) or the
      composed one `relationTypes` names. */ _%>
<%_ if (_first) { _%>
  // ═══════════════════════════════════════════════════════════════════════
  // Relationship composition methods (CGP-358b / CGP-62)
  // Two queries, no SQL JOIN.
  // ═══════════════════════════════════════════════════════════════════════
<%_ } _%>
<%_ const _r = relationTypes[m.name]; _%>
<%_ const _repo = _r.repoProperty ? `this.${_r.repoProperty}` : 'this.repository'; _%>
<%_ const _id = m.params[0].name; _%>
<%_ if (m.kind === 'relation_one') { _%>

  /**
   * Fetch the <%= _r.targetClass %> parent for this <%= entityNamePascal %>.
   * Two repo calls: find self by id → find target by FK.
   */
  async <%= m.name %>(<%- _id %>: string): Promise<<%= _r.targetClass %> | null> {
    const entity = await this.repository.findById(<%- _id %>);
    if (!entity) return null;
    return entity.<%= _r.fkProperty %> ? <%- _repo %>.<%= m.delegatesTo.method %>(entity.<%= _r.fkProperty %>) : null;
  }
<%_ } else { _%>

  /**
   * Fetch <%= _r.relationship %> for this <%= entityNamePascal %> by FK traversal.
   * Single repo call; `limit` caps it (ordered by `id`, so the subset is stable).
   */
  async <%= m.name %>(<%- _id %>: string, <%= m.params[1].name %>?: { limit?: number }): Promise<<%= _r.targetClass %>[]> {
    return <%- _repo %>.<%= m.delegatesTo.method %>(<%- _id %>, <%= m.params[1].name %>);
  }
<%_ } _%>
<%_ } else if (m.kind.startsWith('junction_')) { _%>
<%_ /* JUNC-0 (#678) — junction fan-out, mirrored on both parents (CGP-60;
      docs/relationship-pattern-audit.md §1). Rendered here from the junction
      YAML set, so re-running `entity new` or `junction new` in any order gives
      the same file. `forwardRef` resolves the parent ↔ junction module cycle.
      The junction's own facts (service class + property, link and row types,
      the counterparty type) are the fan-out block's; the names are the
      derivation's. */ _%>
<%_ if (_first) { _%>
<%_ /* the queries block ends on a blank line; the forwarder / composition blocks do not */ _%>
<%_ if (_prev === 'capability_forwarder' || _prev === 'relation') { _%>

<%_ } _%>
  // ═══════════════════════════════════════════════════════════════════════
  // Junction fan-out (CGP-60)
  // Delegates to each junction's service; the same association is mirrored
  // on the other parent.
  // ═══════════════════════════════════════════════════════════════════════
<%_ } _%>
<%_ const fan = junctionFanOut.find((f) => f.junction.name === m.delegatesTo.entity); _%>
<%_ const j = fan.junction; _%>
<%_ const _self = m.params[0].name; _%>
<%_ /* The junction's own methods take (left id, right id); this side's id is the first parameter. */ _%>
<%_ const _pair = m.params.length > 1 ? (fan.side === 'left' ? `${_self}, ${m.params[1].name}` : `${m.params[1].name}, ${_self}`) : null; _%>
<%_ if (m.kind === 'junction_attach') { _%>

  // <%= j.name %> — <%= fan.side %> side, fan-out to <%= fan.counterpartyPascal %>
  @Inject(forwardRef(() => <%= j.serviceClass %>))
  private readonly <%= j.serviceProperty %>!: <%= j.serviceClass %>;

  async <%= m.name %>(
    <%= _self %>: string,
    <%= m.params[1].name %>: string,
    <%= m.params[2].name %><%= fan.linkRequired ? '' : '?' %>: <%= j.linkInputType %>,
  ): Promise<<%= j.entityClass %>> {
    return this.<%= j.serviceProperty %>.<%= m.delegatesTo.method %>(<%= _pair %>, <%= m.params[2].name %>);
  }
<%_ } else if (m.kind === 'junction_detach' || m.kind === 'junction_set_primary') { _%>

  async <%= m.name %>(
    <%= _self %>: string,
    <%= m.params[1].name %>: string,
  ): Promise<void> {
    return this.<%= j.serviceProperty %>.<%= m.delegatesTo.method %>(<%= _pair %>);
  }
<%_ } else if (m.kind === 'junction_list') { _%>

  async <%= m.name %>(
    <%= _self %>: string,
    <%= m.params[1].name %>?: { cursor?: string; limit?: number },
  ): Promise<Array<{ entity: <%= fan.counterpartyPascal %>; link: <%= j.entityClass %> }>> {
    return this.<%= j.serviceProperty %>.<%= m.delegatesTo.method %>('<%= fan.side %>', <%= _self %>, <%= m.params[1].name %>) as Promise<
      Array<{ entity: <%= fan.counterpartyPascal %>; link: <%= j.entityClass %> }>
    >;
  }
<%_ } _%>
<%_ } else if (m.kind === 'eav_write') { _%>
<%_ const [_type, _eid, _uid, _fields, _tx] = m.params.map((p) => p.name); _%>

  /**
   * EAV compound write (task #23) — upserts a bag of dynamic fields onto
   * an owning entity in a single transaction. Resolves field keys to
   * definition ids internally (by reading <%= eavDefinitionPascal %>Repository),
   * so use-cases inject only this service. Unknown keys are skipped; the
   * caller is expected to have created the definitions first (auto-create
   * is a later step).
   */
  async <%= m.name %>(
    <%= _type %>: string,
    <%= _eid %>: string,
    <%= _uid %>: string,
    <%= _fields %>: globalThis.Record<string, unknown>,
    <%= _tx %>?: DrizzleTx,
  ): Promise<void> {
    if (!<%= _fields %> || Object.keys(<%= _fields %>).length === 0) return;
    const allDefs = await this.<%= eavDefinitionRepoProperty %>.list();
    const defs = allDefs.filter((d) => (d as any).entityType === <%= _type %>);
    const defIdByKey = new Map(defs.map((d) => [d.key, d.id]));
    const rows = toEavRows(<%= _eid %>, <%= _type %>, <%= _uid %>, <%= _fields %>, defIdByKey);
    if (rows.length === 0) return;
    await this.repository.<%= m.delegatesTo.method %>(rows as Array<globalThis.Partial<<%= classNames.entity %>>>, <%= _tx %>);
  }
<%_ } else if (m.kind === 'eav_read') { _%>
<%_ const _callee = _calleeKind(m); _%>
<%_ if (_callee === 'find_by_id') { _%>
<%_ const _id = m.params[0].name; _%>

  /**
   * EAV paired read (ADR-13): fetch the entity and merge dynamic `field_values`
   * into a single `fields` bag. FieldValueService owns the FieldDefinition
   * lookup internally. Use this for frontend detail views, LLM context,
   * exports.
   */
  async <%= m.name %>(
    <%= _id %>: string,
  ): Promise<(<%= classNames.entity %> & { fields: globalThis.Record<string, unknown> }) | null> {
    const entity = await this.repository.<%= m.delegatesTo.method %>(<%= _id %>);
    if (!entity) return null;
    const fields = await this.fieldValues.findMergedByEntity('<%= entityName %>', <%= _id %>);
    return { ...entity, fields };
  }
<%_ } else if (_callee === 'list') { _%>

  /**
   * EAV paired read (ADR-13): list variant. Fetches all entities then merges
   * each one's EAV fields via FieldValueService. Acceptable for modest result
   * sets; page externally for large collections.
   */
  async <%= m.name %>(): Promise<Array<<%= classNames.entity %> & { fields: globalThis.Record<string, unknown> }>> {
    const entities = await this.repository.<%= m.delegatesTo.method %>();
    if (entities.length === 0) return [];
    return Promise.all(
      entities.map(async (entity) => {
        const fields = await this.fieldValues.findMergedByEntity('<%= entityName %>', entity.id);
        return { ...entity, fields };
      }),
    );
  }
<%_ } else { _%>
<%_ /* The value table's merged read: its callee is the Metadata repository's
      `findByEntityIdAndType`, not a method this template generates. */ _%>
<%_ const [_type, _eid] = m.params.map((p) => p.name); _%>

  /**
   * EAV paired read (task #23) — returns the current merged `{ key: value }`
   * bag for one owning entity. Resolves definition ids to keys internally.
   */
  async <%= m.name %>(
    <%= _type %>: string,
    <%= _eid %>: string,
  ): Promise<globalThis.Record<string, unknown>> {
    const [rows, allDefs] = await Promise.all([
      this.repository.<%= m.delegatesTo.method %>(<%= _eid %>, <%= _type %>),
      this.<%= eavDefinitionRepoProperty %>.list(),
    ]);
    const defs = allDefs.filter((d) => (d as any).entityType === <%= _type %>);
    const defsById = new Map(defs.map((d) => [d.id, { key: d.key }]));
    return mergeEavRows(rows as any, defsById);
  }
<%_ } _%>
<%_ } _%>
<%_ if (_last && _group(m) === 'read') { _%>

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from <%= serviceBaseClass %>:
<%_ /* The pattern's declared lines, verbatim — the derivation lists the
      inherited methods by name, not the lines a pattern groups them into. */ _%>
<%_ serviceInheritedMethods.forEach(line => { _%>
  //   <%= line %>
<%_ }) _%>

<%_ } _%>
<%_ }) _%>
}
