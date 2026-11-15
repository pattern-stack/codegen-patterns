---
to: "<%= outputPaths.repository %>"
force: true
---
<%- generatedBanner %>
import { Injectable, Inject } from '@nestjs/common';
<%_
// ADR-046 — this template PRINTS the repository's methods. Which methods exist,
// what each is called and its parameter names come from `apiSurface`
// (`src/derived/api/`), including the `queries:` × `belongs_to` precedence (a
// plain finder and an FK finder resolving to one name emit once). The TS text
// beside them comes from `queryTypes`, keyed by the derived name (PLAN §4.3).
const _methods = apiSurface.repository.methods.filter((m) => m.emitted);
// READ-1: a plain ordered finder now orders through RQBv2's `orderBy` object, so
// `asc`/`desc` are needed only by an ordered `via:` / `select:` finder.
const _needsOrderFns = _methods.some((m) => m.kind === 'finder_projection' && queryTypes[m.name].order);
const _firstFkFinder = _methods.find((m) => m.kind === 'fk_finder');
const E = classNames.entity;
// READ-1 §2.3 — the generic parameters, options and result of every shaped read.
// `with` exists only where REL-2 §2.5 allows it; `columns` everywhere.
// `with` first, `columns` second — everywhere, the order `<Entity>Result` takes,
// so REL-2's `<Entity>Result<W>` keeps its meaning.
const _typedInclude = apiSurface.repository.typedInclude;
const _readGenerics = _typedInclude
  ? `<W extends ${E}Include = ${E}NoInclude, C extends ${E}Columns | undefined = undefined>`
  : `<C extends ${E}Columns | undefined = undefined>`;
const _readOpts = _typedInclude ? 'ReadOptions<W, C>' : 'ReadOptions<never, C>';
const _readResult = _typedInclude ? `${E}Result<W, C>` : `${E}Result<${E}NoInclude, C>`;
const _withLine = _typedInclude ? '\n      with: opts?.with,' : '';
// RFC-0006 (#875) S3 — the read half of a joined-table family. Which reads exist is the derivation's call
// (`with_base` / `all_kinds` / `kind_by_id` / `list_kind` / `count_kind` / `orphans` entries); the facts the bodies print (the base edge, the kind column and
// its child keys) come from `familyChild` / `familyBase`.
const _ACROSS = ['all_kinds', 'kind_by_id', 'list_kind', 'count_kind'];
const _isAcross = (m) => _ACROSS.includes(m.kind);
const _isRead = (m) => m.kind === 'count' || m.kind === 'with_base' || _isAcross(m) || m.kind === 'orphans';
const _child = _methods.some((m) => m.kind === 'with_base') ? familyChild : null;
const _base = _methods.some(_isAcross) ? familyBase : null;
const _listName = _methods.find((x) => x.kind === 'list').name;
const _findByIdName = _methods.find((x) => x.kind === 'find_by_id').name;
const _EU = entityName.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const _eLower = E.charAt(0).toLowerCase() + E.slice(1);
_%>
<%_
// ONE `drizzle-orm` import (a name twice is TS2300). READ-1: `eq` / `inArray` are unconditional — `findById` /
// `findByIds` use them. The cross-kind reads add `and` / `notExists` / `or` / `sql`, the EAV value table `sql`.
const _ormNames = [
  'eq',
  'inArray',
  ...(hasMultiFieldQuery || _base ? ['and'] : []),
  ...(_needsOrderFns ? ['desc', 'asc'] : []),
  ...(_base ? ['notExists', 'or'] : []),
  ...(eavValueTable || _base ? ['sql'] : []),
];
_%>

import { <%- _ormNames.join(', ') %> } from 'drizzle-orm';
import { DRIZZLE } from '<%= drizzleTokenImport %>';
import type { DrizzleClient<% if (eavValueTable || hasIntegrationSurface) { %>, DrizzleTx<% } %> } from '<%= drizzleTypeImport %>';
// REL-2 (#587): the generated relation graph. `Relations` binds the repository's
// third type parameter; `IncludeOf`/`ResultOf` are what make a `with` include
// typed. Generated code reaching a generated manifest — the runtime package never
// sees it (REL-1 §4).
import type { ColumnsOf, IncludeOf, Relations, ResultOf } from '<%= relationsImport %>';
<%_ if (composedBaseClass) { _%>
import { <%= composedBaseClass %> } from '<%= composedBaseImport %>';
<%_ } else { _%>
import { <%= repositoryBaseClass %> } from '<%= repositoryBaseImport %>';
<%_ capabilityMixins.forEach((cap) => { _%>
import { <%= cap.mixin %> } from '<%= cap.importPath %>';
<%_ }) _%>
<%_ } _%>
<% if (hasIntegrationSurface) { -%>
import type { IntegrationUpsertConfig } from '<%= integrationUpsertConfigImport %>';
<% } -%>
import type { <% if (hasTimestamps || hasSoftDelete || hasUserTracking || scopeTenantScoped || _child?.baseScope) { %>BehaviorConfig, <% } %>ListOptions, ReadOptions, RowFilter } from '<%= baseRepositoryImport %>';
<% if (_child) { -%>
import { flattenBase, type Flattened } from '<%= inheritanceImport %>';
<% } -%>
<% if (_base) { -%>
import { asKind, type Flattened, flattenBase } from '<%= inheritanceImport %>';
<% } -%>
<% if (eavEnabled) { -%>
import { FieldValueService } from '<%= eavFieldValueImportDir %>/<%= eavFieldValueStem %>.service';
<% } -%>
import { <%= entityNamePlural %>, type <%= classNames.entity %> } from './<%= entityFileStem %>.entity';
<%_ if (_child?.baseScope) { _%>
import { <%= _child.baseTable %> } from '<%= _child.baseImportPath %>';
<%_ } _%>
<%_ if (_base) { _%>
<%_ _base.children.forEach((c) => { _%>
import { <%= c.plural %>, type <%= c.className %> } from '<%= c.entityImportPath %>';
<%_ }) _%>
<%_ } _%>
<%_ capabilityConfigImports.forEach((imp) => { _%>
import { <%= imp.name %> } from '<%= imp.importPath %>';
<%_ }) _%>
<%_ if (hasIntegrationSurface) { _%>
<%_ integrationParentTableImports.forEach((imp) => { _%>
import { <%= imp.table %> } from '<%= imp.importPath %>';
<%_ }); _%>
<%_ } _%>
<%_ if (hasIntegrationSurface) { _%>

/**
 * Canonical fields a integrated <%= entityName %> write carries (#374). Copy-through
 * columns are typed from the entity; each FK is named by its parent's external
 * id and resolved <%= integrationFkResolvers.length > 0 ? 'in integrationUpsertOne' : 'as configured' %>. Provider/providerMetadata are persistence
 * seam, not carried here.
 */
export interface <%= classNames.entity %>IntegrationWrite {
  readonly externalId: string;
<%_ integrationWriteFields.forEach((f) => { _%>
  readonly <%= f.camelName %>: <%- f.tsType %>;
<%_ }); _%>
<%_ integrationWriteFkFields.forEach((f) => { _%>
  readonly <%= f.name %>?: <%- f.tsType %>;
<%_ }); _%>
  /** Flat custom-field bag (EAV). */
  readonly fields?: globalThis.Record<string, unknown>;
}

/**
 * Canonical-projected view of a <%= entityName %> row, keyed for the integration differ
 * (#374). external_id_tracking columns (provider/providerMetadata) are OMITTED;
 * externalId is kept.
 */
export interface <%= classNames.entity %>IntegrationProjection {
<%_ integrationProjectionFields.forEach((f) => { _%>
  readonly <%= f.camelName %>: <%- f.tsType %>;
<%_ }); _%>
}
<%_ } _%>

/**
 * The root column mask a <%= entityName %> read may take — `{ id?: boolean; … }`
 * (READ-1 §2.2). Inclusion (`true`s) or exclusion (`false`s); never empty.
 */
export type <%= E %>Columns = ColumnsOf<'<%= entityNamePlural %>'>;

/**
 * The relation keys a <%= entityName %> read may include — the `with` surface of
 * `<%= entityNamePlural %>` in this project's graph.
 *
 * `TWith` / `TColumns` are inferred AT THE CALL SITE. Annotating an include or a
 * mask literal with these types widens it and loses the exact result shape, so
 * hoist one into a `const` WITHOUT a type annotation (or with `as const`).
 */
export type <%= E %>Include = IncludeOf<'<%= entityNamePlural %>'>;

/** The default `TWith` — no include. */
export type <%= E %>NoInclude = globalThis.Record<string, never>;

/**
 * The row a <%= entityName %> read resolves to: each included relation nested
 * exactly as asked, the root narrowed by `TColumns` (`undefined` ⇒ every column).
 * `<%= E %>Result` alone is the plain row; `<%= E %>Result<TWith>` is the row
 * with that include. The mask is SECOND so a one-argument `<%= E %>Result<…>`
 * is always an include, never a mask (READ-1 §2.2).
 */
export type <%= E %>Result<
  TWith extends <%= E %>Include = <%= E %>NoInclude,
  TColumns extends <%= E %>Columns | undefined = undefined,
> = ResultOf<'<%= entityNamePlural %>', TWith, TColumns>;

/**
 * The shape an HTTP read returns: the row, plus any allowlisted relation.
 *
 * The controller merges allowlisted fragments at REQUEST time, so which relations
 * are present is not statically known — one of finitely many literals, but not a
 * single one. So the handler's result type is the widened form: every relation
 * OPTIONAL, the row's own columns required. `<%= classNames.entity %>Result<<%= classNames.entity %>Include>`
 * (the fully-included shape) would be wrong here — it claims every relation is
 * always present, which no single request produces.
 *
 * Internal callers keep the exact inferred type, because `TWith` is inferred at
 * the call site (REL-2 §2.3/§5.2).
 */
export type <%= classNames.entity %>ApiResult = <%= classNames.entity %> &
  globalThis.Partial<<%= classNames.entity %>Result<<%= classNames.entity %>Include>>;

<%_ if (_child) { _%>
/**
 * A <%= entityName %> with its base row's columns hoisted to the root (RFC-0006 §3.2) — a projection of ONE
 * read (<%= E %>'s table plus a primary-key join to the base), never a second query path. `columns`, `with`
 * and the scope apply to the read that produced it.
 */
export type <%= E %>Flat<
  TWith extends <%= E %>Include = <%= E %>NoInclude,
  TColumns extends <%= E %>Columns | undefined = undefined,
> = Flattened<<%= E %>Result<TWith & { <%= _child.relKey %>: true }, TColumns>, '<%= _child.relKey %>'>;

<%_ } _%>
<%_ if (_base) { _%>
/** The kinds of a <%= entityName %>: the discriminator's choices. */
export type <%= E %>Kind = <%= E %>['<%= _base.discriminatorProp %>'];

/**
 * A <%= entityName %> read across its kinds (RFC-0006 §3.3): each child nested under its own key, a
 * base-only kind bare. Narrow it with a `switch` on `<%= _base.discriminatorProp %>`.
 */
export type <%= E %>OfKind =
<%- _base.kinds.map((k) => { const c = _base.children.find((x) => x.as === k); return `  | (${E} & { ${_base.discriminatorProp}: '${k}'${c ? `; ${c.relKey}: ${c.className}` : ''} })`; }).join('\n') %>;

/** One kind, flat: the base's columns and the child's, at one level. What `listKind` returns. */
export interface <%= E %>FlatByKind {
<%_ _base.children.forEach((c) => { _%>
  <%= c.as %>: Flattened<<%= E %> & { <%= c.relKey %>: <%= c.className %> }, '<%= c.relKey %>'>;
<%_ }) _%>
}

/** A row filter over this table — what the cross-kind reads hand `list`. */
type <%= E %>RowFilter = RowFilter<typeof <%= entityNamePlural %>>;

/** The relation key each child kind is read under, and the one `asKind` narrows by. */
const <%= _EU %>_CHILD_KEY_BY_KIND = {
<%_ _base.children.forEach((c) => { _%>
  <%= c.as %>: '<%= c.relKey %>',
<%_ }) _%>
} as const;

/** The children a read of these kinds joins — only the kinds asked for, all of them when none are. */
function <%= _eLower %>KindJoins(kinds: readonly <%= E %>Kind[] | undefined): {
<%_ _base.children.forEach((c) => { _%>
  <%= c.relKey %>?: true;
<%_ }) _%>
} {
  return {
<%_ _base.children.forEach((c) => { _%>
    ...(kinds === undefined || kinds.includes('<%= c.as %>') ? { <%= c.relKey %>: true as const } : {}),
<%_ }) _%>
  };
}

/**
 * The orphan predicate: a row whose kind has a child table but no child row (RFC-0006 §2.2). A module-level
 * function with camelCase bindings only, because it reads the children's table exports (emitted-name hygiene, #813).
 */
function <%= _eLower %>OrphanFilter(dbClient: DrizzleClient<Relations>, rootRow: typeof <%= entityNamePlural %>) {
  return or(
<%_ _base.children.forEach((c) => { _%>
    and(
      eq(rootRow.<%= _base.discriminatorProp %>, '<%= c.as %>'),
      notExists(dbClient.select({ one: sql`1` }).from(<%= c.plural %>).where(eq(<%= c.plural %>.id, rootRow.id))),
    ),
<%_ }) _%>
  );
}

<%_ } _%>
@Injectable()
<%_ /* ADR-041: the spine alone, the spine wrapped in one capability mixin, or
      the generated `<Entity>ComposedBase` when two or more stack. Built in
      entity-locals.js so both shapes live in one place. REL-2 (#587) threads
      `Relations` as the spine's THIRD type argument there, so a composed base
      carries the manifest exactly as a bare spine does. */ _%>
export class <%= classNames.repository %> extends <%- repositoryExtendsClause %> {
  readonly table = <%= entityNamePlural %>;
<% if (hasTimestamps || hasSoftDelete || hasUserTracking || scopeTenantScoped || _child?.baseScope) { -%>

<% if (_child) { -%>
  // Behaviors of a joined-table child (RFC-0006 §2.3). The child declares none of the lifecycle behaviors
  // (R5): its tenant column is a copy of the base's, pinned by a composite FK<% if (_child.baseScope) { %>, and its row is in scope only
  // while its base row is (`baseScope`)<% } %>.
<% } else { -%>
  // Behaviors declared in YAML -> generated as config object
<% } -%>
  protected override readonly behaviors: BehaviorConfig = {
    timestamps: <%= !!hasTimestamps %>,
    softDelete: <%= !!hasSoftDelete %>,
    userTracking: <%= !!hasUserTracking %>,
    tenantScoped: <%= !!scopeTenantScoped %>,
<% if (scopeTenantScoped) { -%>
    tenantColumn: '<%= scopeTenantColumn %>',
<% } -%>
<% if (_child?.baseScope) { -%>
    baseScope: { table: <%= _child.baseTable %>, softDelete: <%= _child.baseScope.softDelete %>, userTracking: <%= _child.baseScope.userTracking %> },
<% } -%>
  };
<% } -%>
<% if (scopeTenantScoped) { -%>

  // ADR-042 / TEN-1 — a tenant-scoped entity enforces STRICTLY, with no
  // opt-down: a missing ambient tenant throws rather than reading the union of
  // every tenant (charter I3). Install the boundary that supplies `tenantId`
  // BEFORE flipping `tenant_scoped: true`; see the ADR's rollout section.
  //
  // The same knob governs the user axis, so a tenant-scoped entity that also
  // declares `user_tracking` is strict for that too. Both axes read the same
  // ambient context, and a missing boundary is a missing boundary.
  protected override readonly scopeEnforcement = 'strict' as const;
<% } -%>
<% if (hasPatternConfig) { -%>

  // Per-entity `<%= patternName %>` pattern config (from YAML `config:` block).
  // The pattern's base class declares `protected readonly patternConfig: TConfig`
  // typed via its `configSchema`; this concrete record is read by the base at
  // runtime (identical shape to `behaviors: BehaviorConfig`).
  protected override readonly patternConfig = <%- renderPatternConfigLiteral(patternConfig, '  ', '  ') %> as const;
<% } -%>
<%_ capabilityMixins.filter((cap) => cap.hasConfig).forEach((cap) => { _%>

  // Per-entity `<%= cap.name %>` capability config (from the entity YAML).
  // The capability's mixin declares `<%= cap.configProperty %>`; this concrete
  // record fills it — ADR-041 §6's config hand-off for a layered capability.
  // Public: a runtime-shipped mixin declares it public (declaration emit,
  // ADR-041.1), and a public override also fills a protected declaration.
  override readonly <%= cap.configProperty %> = <%- renderPatternConfigLiteral(cap.config, '  ', '  ') %> as const;
<%_ }) _%>
<%_ if (hasIntegrationSurface) { _%>

  // Inbound-integration write surface (#374). Drives the generic integrationUpsertOne /
  // findByExternalIdProjected / softDeleteByExternalId on the base. FK
  // resolvers carry LIVE Drizzle table handles ('self' → this.table).
  protected readonly integrationConfig: IntegrationUpsertConfig = {
    conflictTarget: [<%- integrationConfig.conflictTarget.map((c) => `'${c}'`).join(', ') %>],
    writeColumns: [<%- integrationConfig.writeColumns.map((c) => `'${c}'`).join(', ') %>],
    fkResolvers: [
<%_ integrationFkResolvers.forEach((fk) => { _%>
      { column: '<%= fk.column %>', writeKey: '<%= fk.writeKey %>', refTable: <%- fk.isSelfFk ? "'self'" : fk.refTable %><%= fk.strict ? ', strict: true' : '' %> },
<%_ }); _%>
    ],
    projectionColumns: [<%- integrationConfig.projectionColumns.map((c) => `'${c}'`).join(', ') %>],
    eav: <%= integrationConfig.eav %>,
    softDelete: <%= integrationConfig.softDelete %>,
  };
<%_ } _%>

<%_ if (eavEnabled) { -%>
  constructor(
    @Inject(DRIZZLE) db: DrizzleClient<Relations>,
    private readonly fieldValues: FieldValueService,
  ) {
    super(db);
    this.requireRelationalQuery('<%= entityNamePlural %>');
    this.claimGeneratedReads(<%= classNames.repository %>);
  }

  /**
   * EAV dual-write override (#374 seam → #124 live path). Delegates to the
   * shared FieldValueService so the inbound-integration write joins the same tx.
   */
  protected override async writeCustomFields(
    db: DrizzleTx,
    entityId: string,
    userId: string,
    fields: globalThis.Record<string, unknown>,
  ): Promise<void> {
    await this.fieldValues.upsertFieldsTransactional('<%= entityName %>', entityId, userId, fields, db);
  }
<%_ } else { -%>
  constructor(@Inject(DRIZZLE) db: DrizzleClient<Relations>) {
    super(db);
    // Every read runs on db.query.<%= entityNamePlural %> — fail HERE, naming the cause,
    // if the injected client was built without the relations manifest.
    this.requireRelationalQuery('<%= entityNamePlural %>');
    // findById / findByIds / list are defined below, so a pattern base class or
    // capability mixin overriding one of them would never run — throw, naming it.
    this.claimGeneratedReads(<%= classNames.repository %>);
  }
<%_ } -%>

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1, docs/specs/READ-1.md; REL-2 #587)
  //
  // Every read takes the same shape knobs — a root `columns` mask<% if (_typedInclude) { %> and a
  // typed `with` include<% } %> — inferred at the call site. The signatures live HERE,
  // not on the base: with `TRelations` and the table key as naked type
  // parameters, `DBQueryConfig<…>['with']` is a TS2536 (REL-2 §2.1).
  //
  // ONE execution path for the read surface below — `findById`, `findByIds`,
  // `list` and every plain `queries:` / `belongs_to` finder run on RQBv2
  // (`db.query.<%= entityNamePlural %>`), with or without options. (`count`, and a
  // `via:` / `select:` finder, keep the core builder's `scopeAnd`.) The root
  // predicate is ONE call — `this.rootFilter(where)`, the caller's row filter AND
  // this repository's scope, both rendered against the table RQBv2 hands the
  // callback. RQBv2 ALIASES the root (`"<%= entityNamePlural %>" as "d0"`), so
  // anything rendered against the real table name would not be in scope there
  // (REL-2 §10 Found #9, #840). Every HOP is scoped by the relations manifest.
  //
  // Depth is uncapped here: charter I4 asks for ONE statement, not a shallow
  // one. The depth cap is an HTTP concern (`api.includes.max_depth`).
  // ═══════════════════════════════════════════════════════════════════════

<%_ /* ADR-046: one loop over the derived, emitted repository methods; `m.kind`
      chooses the body. Names and parameter names are printed, never built. */ _%>
<%_ _methods.forEach((m, i) => { _%>
<%_ if (m.kind === 'find_by_id') { _%>
  override async <%= m.name %><%- _readGenerics %>(
    <%= m.params[0].name %>: string,
    opts?: <%- _readOpts %>,
  ): Promise<<%- _readResult %> | null> {
    const row = await this.db.query.<%= entityNamePlural %>.findFirst({
      where: { RAW: this.rootFilter((t) => eq(t.id, <%= m.params[0].name %>)) },
      columns: this.checkColumns<C>(opts?.columns),<%- _withLine %>
    });
    return (row as <%- _readResult %> | undefined) ?? null;
  }
<%_ } else if (m.kind === 'find_by_ids') { _%>

  /**
   * One statement for many ids (READ-1 §2.4): `[]` issues none (after the scope's
   * boundary check), duplicates are
   * read once, rows come back in INPUT order, and a missing / soft-deleted /
   * out-of-scope id is simply absent. A mask that omits `id` still orders — `id`
   * is selected and stripped again. Not chunked: Postgres caps a statement at
   * 65 535 parameters.
   */
  override async <%= m.name %><%- _readGenerics %>(
    <%= m.params[0].name %>: readonly string[],
    opts?: <%- _readOpts %>,
  ): Promise<Array<<%- _readResult %>>> {
    const unique = this.uniqueIds(<%= m.params[0].name %>);
    if (unique.length === 0) {
      // No statement — but the same boundary check one would make (strict throws).
      this.assertReadScope();
      return [];
    }
    const mask = this.byIdsColumns(this.checkColumns<C>(opts?.columns));
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: { RAW: this.rootFilter((t) => inArray(t.id, unique)) },
      columns: mask.columns,<%- _withLine %>
    });
    return this.inInputOrder(rows, unique, mask.stripId) as Array<<%- _readResult %>>;
  }
<%_ } else if (m.kind === 'list') { _%>

  /**
   * `where` is a ROW FILTER — `(t) => eq(t.name, x)` — never a pre-rendered SQL:
   * it is handed the aliased root. `sort` is column keys, rendered the same way.
   */
  override async <%= m.name %><%- _readGenerics %>(
    <%= m.params[0].name %>?: ListOptions<typeof <%= entityNamePlural %>> & <%- _readOpts %>,
  ): Promise<Array<<%- _readResult %>>> {
    const sort = <%= m.params[0].name %>?.sort;
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: { RAW: this.rootFilter(<%= m.params[0].name %>?.where) },
      columns: this.checkColumns<C>(<%= m.params[0].name %>?.columns),<%- _typedInclude ? `\n      with: ${m.params[0].name}?.with,` : '' %>
      orderBy: sort === undefined || sort.length === 0 ? undefined : (t) => this.orderByOn(t, sort) ?? [],
      limit: <%= m.params[0].name %>?.limit,
      offset: <%= m.params[0].name %>?.offset,
    });
    return rows as Array<<%- _readResult %>>;
  }
<%_ } else if (m.kind === 'count') { _%>

  /**
   * `where` is a ROW FILTER over THIS table. Overridden only to type it: inside a
   * capability mixin the base's `count` is typed over `PgTable`, which would let
   * another table's filter through — and, where column names coincide, count on
   * the wrong predicate (READ-1 review R-1).
   */
  override async <%= m.name %>(<%= m.params[0].name %>?: RowFilter<typeof <%= entityNamePlural %>>): Promise<number> {
    return super.<%= m.name %>(<%= m.params[0].name %>);
  }
<%_ } else if (m.kind === 'with_base' || _isAcross(m) || m.kind === 'orphans') { _%>
<%_ /* RFC-0006 (#875) §3 — the family reads. Each is a derived method (`src/derived/api/entity.ts`, caused by the
      child's `inherits:` or the base's `discriminator:`); the first of each kind opens its banner. */ _%>
<%_ const _p = m.params.map((x) => x.name); _%>
<%_ const _firstOfKind = i === 0 || (_isAcross(m) ? !_isAcross(_methods[i - 1]) : _methods[i - 1].kind !== m.kind); _%>
<%_ if (m.kind === 'with_base') { _%>
<%_ if (_firstOfKind) { _%>

  // ═══════════════════════════════════════════════════════════════════════
  // The base row (RFC-0006 §3.2, #875) — a <%= entityName %> IS a kind of a <%= _child.relKey %>
  //
  // `findWithBase` is `findById` with the base joined in and its columns hoisted
  // to the root: it CALLS `findById` / `findByIds`, so ONE statement (a primary-key
  // lateral join) and the one scope body — `columns` / `with` still apply to this table.
  // ═══════════════════════════════════════════════════════════════════════
<%_ } _%>
<%_ if (m.returns === 'one') { _%>

  async <%= m.name %><W extends <%= E %>Include & { <%= _child.relKey %>?: never } = <%= E %>NoInclude, C extends <%= E %>Columns | undefined = undefined>(
    <%= _p[0] %>: string,
    <%= _p[1] %>?: ReadOptions<W, C>,
  ): Promise<<%= E %>Flat<W, C> | null> {
    const row = await this.findById(<%= _p[0] %>, { ...<%= _p[1] %>, with: { ...<%= _p[1] %>?.with, <%= _child.relKey %>: true as const } } as never);
    return row ? (flattenBase(row as never, '<%= _child.relKey %>') as <%= E %>Flat<W, C>) : null;
  }
<%_ } else { _%>

  /** One statement for many ids, flat — it IS `findByIds` (no statement for `[]`, input order, absent when out of scope), with the base joined in. */
  async <%= m.name %><W extends <%= E %>Include & { <%= _child.relKey %>?: never } = <%= E %>NoInclude, C extends <%= E %>Columns | undefined = undefined>(
    <%= _p[0] %>: readonly string[],
    <%= _p[1] %>?: ReadOptions<W, C>,
  ): Promise<Array<<%= E %>Flat<W, C>>> {
    const rows = await this.findByIds(<%= _p[0] %>, { ...<%= _p[1] %>, with: { ...<%= _p[1] %>?.with, <%= _child.relKey %>: true as const } } as never);
    return rows.map((row) => flattenBase(row as never, '<%= _child.relKey %>')) as Array<<%= E %>Flat<W, C>>;
  }
<%_ } _%>
<%_ } else if (_isAcross(m)) { _%>
<%_ if (_firstOfKind) { _%>

  // ═══════════════════════════════════════════════════════════════════════
  // Reading across kinds (RFC-0006 §3.3, §6, #875)
  //
  // The base scan plus ONE primary-key lateral join per child kind asked for —
  // a single statement (charter I4), on the same root scope as every read here.
  // Each child is scoped by the relations manifest like any other hop.
  // ═══════════════════════════════════════════════════════════════════════
<%_ } _%>
<%_ if (m.kind === 'all_kinds') { _%>

  /**
   * Every row with its child nested under its kind's key, a base-only kind bare. `kinds` filters the scan
   * and joins only those children. A row whose kind has a child table but no child row throws
   * `OrphanBaseError` (see `findOrphans`).
   */
  async <%= m.name %>(
    <%= _p[0] %>?: ListOptions<typeof <%= entityNamePlural %>> & { kinds?: readonly <%= E %>Kind[] },
  ): Promise<<%= E %>OfKind[]> {
    const kinds = <%= _p[0] %>?.kinds;
    const where: <%= E %>RowFilter = (t) =>
      and(<%= _p[0] %>?.where?.(t), kinds === undefined ? undefined : inArray(t.<%= _base.discriminatorProp %>, [...kinds]));
    const rows = await this.<%= _listName %>({
      where,
      sort: <%= _p[0] %>?.sort,
      limit: <%= _p[0] %>?.limit,
      offset: <%= _p[0] %>?.offset,
      with: <%= _eLower %>KindJoins(kinds),
    } as never);
    return rows.map((row) => asKind<<%= E %>OfKind>(row, '<%= _base.discriminator %>', <%= _EU %>_CHILD_KEY_BY_KIND));
  }
<%_ } else if (m.kind === 'kind_by_id') { _%>

  /** One row by id with its child, narrowed by kind. `null` when absent or out of scope. */
  async <%= m.name %>(<%= _p[0] %>: string): Promise<<%= E %>OfKind | null> {
    const row = await this.<%= _findByIdName %>(<%= _p[0] %>, { with: <%= _eLower %>KindJoins(undefined) } as never);
    return row ? asKind<<%= E %>OfKind>(row, '<%= _base.discriminator %>', <%= _EU %>_CHILD_KEY_BY_KIND) : null;
  }
<%_ } else if (m.kind === 'list_kind') { _%>

  /**
   * One kind, flat (the base's columns and the child's at one level), filtered and sorted on BASE columns —
   * the read a child's HTTP list uses, since `created_at` and `occurred_at` live here.
   */
  async <%= m.name %><K extends keyof <%= E %>FlatByKind>(
    <%= _p[0] %>: K,
    <%= _p[1] %>?: ListOptions<typeof <%= entityNamePlural %>>,
  ): Promise<Array<<%= E %>FlatByKind[K]>> {
    const where: <%= E %>RowFilter = (t) =>
      and(eq(t.<%= _base.discriminatorProp %>, <%= _p[0] %>), <%= _p[1] %>?.where?.(t));
    const rows = await this.<%= _listName %>({
      where,
      sort: <%= _p[1] %>?.sort,
      limit: <%= _p[1] %>?.limit,
      offset: <%= _p[1] %>?.offset,
      with: <%= _eLower %>KindJoins([<%= _p[0] %>]),
    } as never);
    return rows.map((row) =>
      flattenBase(
        asKind<<%= E %>OfKind>(row, '<%= _base.discriminator %>', <%= _EU %>_CHILD_KEY_BY_KIND) as never,
        <%= _EU %>_CHILD_KEY_BY_KIND[<%= _p[0] %>],
      ),
    ) as unknown as Array<<%= E %>FlatByKind[K]>;
  }
<%_ } else { _%>

  /** How many rows of one kind, on the same scope as `count`. */
  async <%= m.name %>(<%= _p[0] %>: <%= E %>Kind, <%= _p[1] %>?: RowFilter<typeof <%= entityNamePlural %>>): Promise<number> {
    return this.count((t) => and(eq(t.<%= _base.discriminatorProp %>, <%= _p[0] %>), <%= _p[1] %>?.(t)));
  }
<%_ } _%>
<%_ } else { _%>

  /**
   * Rows whose kind has a child table but no child row — the integrity the database cannot enforce (the base
   * is inserted first, RFC-0006 §2.2). For jobs and tests; the generated write path never produces one. One
   * statement, on the base's root scope: a child row is looked for whatever ITS scope says, because an absent
   * child is the question.
   */
  async <%= m.name %>(<%= _p[0] %>?: { limit?: number }): Promise<<%= E %>[]> {
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: { RAW: this.rootFilter((t) => <%= _eLower %>OrphanFilter(this.db, t)) },
      // A `limit` without an order is an arbitrary subset; `id` makes it one.
      orderBy: { id: 'asc' },
      limit: <%= _p[0] %>?.limit,
    });
    return rows as <%= E %>[];
  }
<%_ } _%>
<%_ } else if (m.kind === 'finder' || m.kind === 'finder_projection') { _%>
<%_
// The `by:` columns are the parameters that bind a field; their TS types come
// from `queryTypes`, in the same order.
const _t = queryTypes[m.name];
const _cols = m.params.filter((p) => p.field !== undefined);
const _sig = _cols.map((p, i) => `${p.name}: ${_t.params[i].tsType}`).join(', ');
const _multi = _cols.length > 1;
const _pred = _cols.map((p) => `eq(t.${p.name}, ${p.name})`);
const _predExpr = _multi ? `and(${_pred.join(', ')})` : _pred[0];
_%>
<%_ /* A plain by-column finder takes the read options (READ-1 §2.3). A `select:`
      projection returns picked fields and a `via:` finder joins a junction with
      its own query, so neither carries them — REL-2 §5.4: the read surface
      exposes SHAPES, not queries. */ _%>
<%_ if (m.kind === 'finder_projection') { _%>

  async <%= m.name %>(<%- _sig %>): Promise<<%- _t.returnType %>> {
<% if (m.unique) { -%>
    const rows = await this.baseQuery(<%- _multi ? 'and(' : '' %><%- _cols.map(p => `eq(this.table['${p.name}'], ${p.name})`).join(', ') %><%- _multi ? ')' : '' %>)
      .limit(1);
    return (rows[0] as <%= classNames.entity %>) ?? null;
<% } else { -%>
    const rows = await this.baseQuery(<%- _multi ? 'and(' : '' %><%- _cols.map(p => `eq(this.table['${p.name}'], ${p.name})`).join(', ') %><%- _multi ? ')' : '' %>)<%- _t.order ? `.orderBy(${_t.order.direction}(this.table['${_t.order.property}']))` : '' %>;
    return rows as <%= classNames.entity %>[];
<% } -%>
  }
<%_ } else { _%>

  async <%= m.name %><%- _readGenerics %>(
    <%- _sig %>,
    opts?: <%- _readOpts %>,
  ): Promise<<%- m.unique ? `${_readResult} | null` : `Array<${_readResult}>` %>> {
<% if (m.unique) { -%>
    const row = await this.db.query.<%= entityNamePlural %>.findFirst({
      where: { RAW: this.rootFilter((t) => <%- _predExpr %>) },
      columns: this.checkColumns<C>(opts?.columns),<%- _withLine %>
    });
    return (row as <%- _readResult %> | undefined) ?? null;
<% } else { -%>
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: { RAW: this.rootFilter((t) => <%- _predExpr %>) },
      columns: this.checkColumns<C>(opts?.columns),<%- _withLine %>
<%- _t.order ? `      orderBy: { ${_t.order.property}: '${_t.order.direction}' },\n` : '' %>    });
    return rows as Array<<%- _readResult %>>;
<% } -%>
  }
<%_ } _%>
<%_ } else if (m.kind === 'fk_finder') { _%>
<%_
// The FK column's property is the `belongs_to` entry's own, found by the
// foreign key the derivation names.
const _fkColumn = belongsTo.find((rel) => rel.field === m.params[0].field).camelField;
_%>
<%_ if (m === _firstFkFinder) { _%>

  // ═══════════════════════════════════════════════════════════════════════
  // FK traversal methods (from belongs_to relationships — CGP-358b)
  // Called by service-layer composition methods on the inverse (has_many) side.
  // A FK method whose name collides with a unique/via/select declarative query
  // is skipped — that declarative query is the more specific intent and wins.
  // ═══════════════════════════════════════════════════════════════════════
<%_ } _%>

  async <%= m.name %><%- _readGenerics %>(
    <%= m.params[0].name %>: string,
    opts?: { limit?: number } & <%- _readOpts %>,
  ): Promise<Array<<%- _readResult %>>> {
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: { RAW: this.rootFilter((t) => eq(t.<%= _fkColumn %>, <%= m.params[0].name %>)) },
      columns: this.checkColumns<C>(opts?.columns),<%- _withLine %>
      // A `limit` without an order is an arbitrary subset; `id` makes it one.
      orderBy: opts?.limit === undefined ? undefined : { id: 'asc' },
      limit: opts?.limit,
    });
    return rows as Array<<%- _readResult %>>;
  }
<%_ } else if (m.kind === 'eav_upsert') { _%>

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
  async <%= m.name %>(
    <%= m.params[0].name %>: Array<globalThis.Partial<<%= classNames.entity %>>>,
    <%= m.params[1].name %>?: DrizzleTx,
  ): Promise<<%= classNames.entity %>[]> {
    if (<%= m.params[0].name %>.length === 0) return [];
    const data = <%= m.params[0].name %>.map((input) =>
      this.withTimestamps(input as globalThis.Record<string, unknown>, 'create'),
    );
    const runner = this.runner(<%= m.params[1].name %>);
    const rows = await runner
      .insert(this.tableRef)
      .values(data)
      .onConflictDoUpdate({
        target: [
          this.col('entityType'),
          this.col('entityId'),
          this.col('fieldDefinitionId'),
        ],
        set: {
          value: sql`excluded.value`,
          userId: sql`excluded.user_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning();
    return rows as <%= classNames.entity %>[];
  }
<%_ } _%>
<%_ /* The section banner prints once the core and family reads end — whenever the YAML declares a by-column
      finder, even one that lost its name to an FK finder below. */ _%>
<%_ if (_isRead(m) && !(i + 1 < _methods.length && _isRead(_methods[i + 1]))) { _%>
<% if (hasDeclarativeQueries) { -%>

  // ═══════════════════════════════════════════════════════════════════════
  // Declarative queries (from queries: block in entity YAML)
  // ═══════════════════════════════════════════════════════════════════════
<% } -%>
<%_ } _%>
<%_ }) _%>

  // Inherited from <%= repositoryBaseClass %>:
<%_ repositoryInheritedMethods.forEach(line => { _%>
  //   <%= line %>
<%_ }) _%>
}
