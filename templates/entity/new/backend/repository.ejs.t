---
to: "<%= outputPaths.repository %>"
force: true
---
<%- generatedBanner %>
<% if (!patternStackWiring) { -%>
import { Injectable, Inject } from '@nestjs/common';
<% } -%>
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
const _isRead = (m) => m.kind === 'count' || m.kind === 'with_base' || m.kind === 'list_flat' || m.kind === 'count_flat' || _isAcross(m) || m.kind === 'orphans';
// The write kinds (S4) close the same run: the `queries:` banner comes after the last of them.
const _PAIR = ['pair_create', 'pair_update', 'pair_delete'];
const _isPair = (m) => _PAIR.includes(m.kind);
const _isWrite = (m) => _isPair(m) || m.kind === 'kind_guard' || m.kind === 'create_guard' || m.kind === 'upsert_own' || m.kind === 'upsert_through_base';
const _child = _methods.some((m) => m.kind === 'with_base') ? familyChild : null;
const _base = _methods.some(_isAcross) ? familyBase : null;
const _listName = _methods.find((x) => x.kind === 'list').name;
const _findByIdName = _methods.find((x) => x.kind === 'find_by_id').name;
const _C = familyConstName;
const _H = familyHelperName;
// RFC-0006 (#875) S4 — the write half. Which writes exist is the derivation's call (`pair_create` / `pair_update` / `pair_delete` /
// `kind_guard` / `upsert_own` / `upsert_through_base` entries): a child writes both rows, a base refuses to change a row's kind, an entity with a natural key
// upserts. `matchFills`: columns this table derives from a parent row; `naturalKey`: the conflict target.
const _derived = matchFills.length > 0;
// The derived-column hook prints right after the last read, before the first write.
const _lastRead = _methods.reduce((last, m, k) => (_isRead(m) ? k : last), -1);
if (_derived && _lastRead < 0) throw new Error(`[codegen] '${entityName}': a table with \`match:\` columns and no read method`);
const _pairWrite = _methods.some(_isPair);
// A child's upsert goes through its base's natural key; an entity's own is its declared index — the derivation says which.
const _upsert = _methods.some((m) => m.kind === 'upsert_own');
const _childUpsert = _methods.some((m) => m.kind === 'upsert_through_base');
// A base refuses a `kind` change even when every kind is base-only (no child table).
const _baseWrites = _methods.some((m) => m.kind === 'kind_guard');
// A base with a child table refuses a write that names a kind owned by a child (the one owner of `KindRequiresChildError`, D16).
const _createGuard = _methods.some((m) => m.kind === 'create_guard');
const _discProp = familyBase ? familyBase.discriminatorProp : null;
const _upsertGuarded = _upsert && (_discProp !== null || hasUserTracking);
// Every drizzle-orm name this file imports, in ONE set printed as ONE import (a second import of a name is TS2300).
const _orm = [...new Set([
  'eq', 'inArray',
  ...(hasMultiFieldQuery || _base || _upsertGuarded ? ['and'] : []),
  ...(_needsOrderFns ? ['desc', 'asc'] : []),
  ...(_base ? ['notExists', 'or'] : []),
  ...(eavValueTable || _base || _childUpsert || _upsert ? ['sql'] : []),
  ...(_child || _upsert ? ['getTableColumns'] : []),
])];
// The runtime helpers the write half calls, merged with the read half's into ONE import.
const _inhValues = [...new Set([
  ...(_pairWrite ? ['flattenBase', 'inTransaction', 'KindImmutableError', 'KindMismatchError', 'PAIR_WRITE', 'splitByOwner'] : []),
  ...(_childUpsert ? ['PAIR_WRITE', 'upsertSet'] : []),
  ...(_createGuard ? ['assertBaseOnlyKind'] : []),
  ...(_base ? ['asKind', 'flattenBase'] : []),
  ...(_baseWrites ? ['KindImmutableError'] : []),
  ...(_upsert ? ['upsertSet', ...(_discProp ? ['KindMismatchError'] : []), ...(hasUserTracking ? ['OutOfScopeWriteError'] : [])] : []),
  ...(_derived ? ['fillDerivedColumns'] : []),
])].sort((a, b) => a.localeCompare(b, 'en'));
const _inhTypes = [...(_child || _base ? ['Flattened'] : []), ...(_createGuard ? ['PairWrite'] : []), ...(_derived ? ['DerivedColumn'] : [])].sort();
const _needsTx = eavValueTable || hasIntegrationSurface || _child || _baseWrites || _createGuard || _upsert;
// Parent tables a derived column is read from, not already imported by the entity / family blocks.
const _tableAlready = new Set([entityNamePlural, ...(_child ? [_child.baseTable] : []), ...(_base ? _base.children.map((c) => c.plural) : [])]);
const _parentImports = [...new Map(matchFills.flatMap((f) => f.sources).filter((x) => !_tableAlready.has(x.parentTable)).map((x) => [x.parentTable, x])).values()];
_%>
<%# READ-1: `eq` / `inArray` are unconditional — `findById` / `findByIds` use them. %>
import { <%- _orm.join(', ') %> } from 'drizzle-orm';
<% if (!patternStackWiring) { -%>
import { DRIZZLE } from '<%= drizzleTokenImport %>';
<% } -%>
import type { DrizzleClient<% if (_needsTx) { %>, DrizzleTx<% } %> } from '<%= drizzleTypeImport %>';
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
<% if (_inhValues.length > 0) { -%>
import { <%- [..._inhValues, ..._inhTypes.map((t) => `type ${t}`)].join(', ') %> } from '<%= inheritanceImport %>';
<% } -%>
<% if (eavEnabled) { -%>
import { FieldValueService } from '<%= eavFieldValueImportDir %>/<%= eavFieldValueStem %>.service';
<% } -%>
import { <%= entityNamePlural %>, type <%= classNames.entity %> } from './<%= entityFileStem %>.entity';
<%_ if (_child) { _%>
import { <%= _child.baseTable %>, type <%= _child.baseClass %> } from '<%= _child.baseImportPath %>';
import { <%= _child.baseRepositoryClass %> } from '<%= _child.baseRepositoryImportPath %>';
<%_ } _%>
<%_ _parentImports.forEach((imp) => { _%>
import { <%= imp.parentTable %> } from '<%= imp.parentImportPath %>';
<%_ }) _%>
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
<%_ if (_child) { _%>
 *
 * A child's HTTP result is FLAT (RFC-0006 §5): the base's columns are in the body, so the base relation is never an
 * include and never needs an allowlist entry.
<%_ } _%>
 */
<%_ if (_child) { _%>
export type <%= classNames.entity %>ApiResult = <%= classNames.entity %>Flat &
  globalThis.Partial<globalThis.Omit<<%= classNames.entity %>Result<<%= classNames.entity %>Include>, '<%= _child.relKey %>'>>;
<%_ } else { _%>
export type <%= classNames.entity %>ApiResult = <%= classNames.entity %> &
  globalThis.Partial<<%= classNames.entity %>Result<<%= classNames.entity %>Include>>;
<%_ } _%>

<%_ if (_child) { _%>
/**
 * A <%= entityName %> with its base row's columns hoisted to the root (RFC-0006 §3.2) — a projection of ONE
 * read (<%= E %>'s table plus a primary-key join to the base), never a second query path. `columns`, `with`
 * and the scope apply to the read that produced it.
 */
export type <%= E %>Flat<
  TWith extends <%= E %>Include = <%= E %>NoInclude,
  TColumns extends <%= E %>Columns | undefined = undefined,
> = Flattened<
  <%= E %>Result<
    // The default include is `Record<string, never>`: its index signature would make the base key `never` and the whole
    // flat row `never`. Keep the keys the caller named, drop the signature.
    { [K in keyof TWith as string extends K ? never : K]: TWith[K] } & { <%= _child.relKey %>: true },
    TColumns
  >,
  '<%= _child.relKey %>'
>;

/**
 * The flat input of a <%= entityName %> write (RFC-0006 §4.1): the base's columns and this table's, at one level.
 * `<%= _child.discriminatorProp %>` is fixed by the child ('<%= _child.as %>') and is not an input. An update takes the same shape, every key optional.
 */
export type <%= E %>Create = globalThis.Partial<globalThis.Omit<<%= _child.baseClass %>, '<%= _child.discriminatorProp %>'>> &
  globalThis.Partial<globalThis.Omit<<%= E %>, '<%= _child.discriminatorProp %>'>>;
export type <%= E %>Update = <%= E %>Create;

/** The base table's column keys: what a flat input is split by (`splitByOwner`). */
const <%= _C('BASE') %> = <%= _child.baseTable %>;
export const <%= _C('BASE_KEYS') %>: globalThis.ReadonlySet<string> = new globalThis.Set(globalThis.Object.keys(getTableColumns(<%= _C('BASE') %>)));

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
const <%= _C('CHILD_KEY_BY_KIND') %> = {
<%_ _base.children.forEach((c) => { _%>
  <%= c.as %>: '<%= c.relKey %>',
<%_ }) _%>
} as const;

/** The children a read of these kinds joins — only the kinds asked for, all of them when none are. */
function <%= _H('KindJoins') %>(kinds: readonly <%= E %>Kind[] | undefined): {
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
function <%= _H('OrphanFilter') %>(dbClient: DrizzleClient<Relations>, rootRow: typeof <%= entityNamePlural %>) {
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
<%_ if (_createGuard) { _%>
/** The kinds that have a child table, and the create path that writes both rows for each (`KindRequiresChildError`). */
const <%= _C('CHILD_CREATE_PATH') %> = {
<%_ familyBase.children.forEach((c) => { _%>
  <%= c.as %>: '<%= c.createPath %>',
<%_ }) _%>
} as const;

<%_ } _%>
<%_ if (_derived) { _%>
/**
 * The columns this table derives from a parent row, each with the parents it is read from (RFC-0006 §2.4): filled
 * by a scalar subquery on the parent's primary key, in the same statement as the write.
 */
const <%= _C('DERIVED') %>: readonly DerivedColumn[] = [
<%_ matchFills.forEach((f) => { _%>
  {
    key: '<%= f.key %>',
    sources: [
<%_ f.sources.forEach((src) => { _%>
      { fkKey: '<%= src.fkKey %>', fkColumn: <%= entityNamePlural %>.<%= src.fkKey %>, parentTable: <%= src.parentTable %>, parentId: <%= src.parentTable %>.id, parentValue: <%= src.parentTable %>.<%= src.parentProp %> },
<%_ }) _%>
    ],
  },
<%_ }) _%>
];

<%_ } _%>
<%_ if (_upsert) { _%>
/** The conflict target of `upsertByNaturalKey`: the declared `natural_key`, tenant-prefixed as its unique index is. */
const <%= _C('NATURAL_KEY') %> = [<%- naturalKey.props.map((p) => `'${p}'`).join(', ') %>] as const;

/** What an upsert's `DO UPDATE` never rewrites: the key, the kind, the tenant, the natural key's columns, `createdAt`. */
const <%= _C('UPSERT_NEVER') %>: globalThis.ReadonlySet<string> = new globalThis.Set([
  'id',
<%_ if (_discProp) { _%>
  '<%= _discProp %>',
<%_ } _%>
<%_ if (scopeTenantScoped) { _%>
  '<%= scopeTenantColumn %>',
<%_ } _%>
<%_ if (hasUserTracking) { _%>
  'userId',
<%_ } _%>
<%_ naturalKey.props.filter((p) => p !== scopeTenantColumn && p !== _discProp).forEach((p) => { _%>
  '<%= p %>',
<%_ }) _%>
  'createdAt',
]);

<%_ } _%>
<% if (!patternStackWiring) { -%>
@Injectable()
<% } -%>
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
    <%= patternStackWiring ? '' : '@Inject(DRIZZLE) ' %>db: DrizzleClient<Relations>,
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
<%_ if (_child) { _%>
  constructor(
    <%= patternStackWiring ? '' : '@Inject(DRIZZLE) ' %>db: DrizzleClient<Relations>,
    // The pair write goes through the base's OWN repository, so its tenant stamp and timestamps apply (RFC-0006 §4.1).
    private readonly baseRepo: <%= _child.baseRepositoryClass %>,
  ) {
<%_ } else { _%>
  constructor(<%= patternStackWiring ? '' : '@Inject(DRIZZLE) ' %>db: DrizzleClient<Relations>) {
<%_ } _%>
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
<%_ } else if (m.kind === 'list_flat' || m.kind === 'count_flat') { _%>
<%_ const _p = m.params.map((x) => x.name); _%>
<%_ if (m.kind === 'list_flat') { _%>

  /**
   * This kind's rows, flat, filtered and sorted on the BASE's columns (RFC-0006 §3.3): the base's `<%= m.delegatesTo.method %>`, which
   * is what a child's HTTP list reads — its default sort is `created_at desc, id desc`, and `created_at` is the base's.
   * `opts.with` names this table's own relations; they are joined in the same statement.
   */
  async <%= m.name %><W extends <%= E %>Include = <%= E %>NoInclude>(
    <%= _p[0] %>?: ListOptions<typeof <%= _child.baseTable %>>,
    <%= _p[1] %>?: { with?: W },
  ): Promise<Array<<%= E %>Flat<W>>> {
    return this.baseRepo.<%= m.delegatesTo.method %>('<%= _child.as %>', <%= _p[0] %>, <%= _p[1] %>?.with) as unknown as Array<<%= E %>Flat<W>>;
  }
<%_ } else { _%>

  /** How many rows `<%= _methods.find((x) => x.kind === 'list_flat').name %>` ranges over, on the same scope: the base's `<%= m.delegatesTo.method %>`. */
  async <%= m.name %>(<%= _p[0] %>?: RowFilter<typeof <%= _child.baseTable %>>): Promise<number> {
    return this.baseRepo.<%= m.delegatesTo.method %>('<%= _child.as %>', <%= _p[0] %>);
  }
<%_ } _%>
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
      with: <%= _H('KindJoins') %>(kinds),
    } as never);
    return rows.map((row) => asKind<<%= E %>OfKind>(row, '<%= _base.discriminator %>', <%= _C('CHILD_KEY_BY_KIND') %>));
  }
<%_ } else if (m.kind === 'kind_by_id') { _%>

  /** One row by id with its child, narrowed by kind. `null` when absent or out of scope. */
  async <%= m.name %>(<%= _p[0] %>: string): Promise<<%= E %>OfKind | null> {
    const row = await this.<%= _findByIdName %>(<%= _p[0] %>, { with: <%= _H('KindJoins') %>(undefined) } as never);
    return row ? asKind<<%= E %>OfKind>(row, '<%= _base.discriminator %>', <%= _C('CHILD_KEY_BY_KIND') %>) : null;
  }
<%_ } else if (m.kind === 'list_kind') { _%>

  /**
   * One kind, flat (the base's columns and the child's at one level), filtered and sorted on BASE columns —
   * the read a child's HTTP list uses, since `created_at` and `occurred_at` live here.
   *
   * `childWith` is an include tree for the CHILD's own includes (`{ transcripts: true }`): it is joined under the
   * child's relation key in the same statement (charter I4), so a child list with an include is still one statement.
   */
  async <%= m.name %><K extends keyof <%= E %>FlatByKind>(
    <%= _p[0] %>: K,
    <%= _p[1] %>?: ListOptions<typeof <%= entityNamePlural %>>,
    <%= _p[2] %>?: globalThis.Record<string, unknown>,
  ): Promise<Array<<%= E %>FlatByKind[K]>> {
    const where: <%= E %>RowFilter = (t) =>
      and(eq(t.<%= _base.discriminatorProp %>, <%= _p[0] %>), <%= _p[1] %>?.where?.(t));
    const rows = await this.<%= _listName %>({
      where,
      sort: <%= _p[1] %>?.sort,
      limit: <%= _p[1] %>?.limit,
      offset: <%= _p[1] %>?.offset,
      with:
        <%= _p[2] %> === undefined
          ? <%= _H('KindJoins') %>([<%= _p[0] %>])
          : ({ [<%= _C('CHILD_KEY_BY_KIND') %>[<%= _p[0] %>]]: { with: <%= _p[2] %> } } as never),
    } as never);
    return rows.map((row) =>
      flattenBase(
        asKind<<%= E %>OfKind>(row, '<%= _base.discriminator %>', <%= _C('CHILD_KEY_BY_KIND') %>) as never,
        <%= _C('CHILD_KEY_BY_KIND') %>[<%= _p[0] %>],
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
      where: { RAW: this.rootFilter((t) => <%= _H('OrphanFilter') %>(this.db, t)) },
      // A `limit` without an order is an arbitrary subset; `id` makes it one.
      orderBy: { id: 'asc' },
      limit: <%= _p[0] %>?.limit,
    });
    return rows as <%= E %>[];
  }
<%_ } _%>
<%_ } else if (m.kind === 'pair_create') { _%>
<%_ const _p = m.params.map((x) => x.name); _%>

  // ═══════════════════════════════════════════════════════════════════════
  // The pair write (RFC-0006 §4.1, #875)
  //
  // A <%= entityName %> is two rows sharing one id: the base's and this table's. `create`, `update` and `delete`
  // OVERRIDE the inherited ones, on purpose — the inherited `create` would insert a row here with no
  // base row. The base half goes through the base's own repository (its tenant stamp, timestamps and
  // soft-delete apply), both halves in ONE transaction: the caller's when a `tx` is passed, else one opened here.
  // ═══════════════════════════════════════════════════════════════════════

  /** The kind this child writes is fixed ('<%= _child.as %>'); an input that names another is refused. */
  private assertOwnKind(baseSlice: globalThis.Record<string, unknown>): void {
    const named = baseSlice['<%= _child.discriminatorProp %>'];
    if (named !== undefined && named !== '<%= _child.as %>') {
      throw new KindMismatchError('<%= entityName %>', '<%= _child.as %>', `the input names kind '${globalThis.String(named)}'`);
    }
  }

  /** Both rows, in one transaction; a failing child insert rolls the base row back. */
  override async <%= m.name %>(<%= _p[0] %>: <%= E %>Create, <%= _p[1] %>?: DrizzleTx): Promise<<%= E %>Flat> {
    const { base, own } = splitByOwner(<%= _p[0] %>, <%= _C('BASE_KEYS') %>);
    this.assertOwnKind(base);
    return inTransaction(this.db, <%= _p[1] %>, async (txClient) => {
      const baseRow = await this.baseRepo.create({ ...base, <%= _child.discriminatorProp %>: '<%= _child.as %>' }, txClient, PAIR_WRITE);
      const [childRow] = await this.runner(txClient)
        .insert(this.table)
        .values(this.childValues({ ...own, id: baseRow.id<% if (childTenantProp) { %>, <%= childTenantProp %>: baseRow.<%= childTenantProp %><% } %> }))
        .returning();
      return this.flat(childRow, baseRow);
    });
  }

  /** A write's values for this table, with its derived `match:` columns filled (typed as the table's insert). */
  private childValues(values: globalThis.Record<string, unknown>): typeof this.table.$inferInsert {
    return this.deriveColumns(values, 'create') as typeof this.table.$inferInsert;
  }

  /** The flat row of a written pair: the one owner of flattening is `flattenBase`. */
  private flat(childRow: <%= E %> | undefined, baseRow: <%= _child.baseClass %>): <%= E %>Flat {
    return flattenBase({ ...childRow, <%= _child.relKey %>: baseRow } as <%= E %> & { <%= _child.relKey %>: <%= _child.baseClass %> }, '<%= _child.relKey %>') as <%= E %>Flat;
  }

<%_ } else if (m.kind === 'pair_update') { _%>
<%_ const _p = m.params.map((x) => x.name); _%>
  /**
   * Update across both tables. A `<%= _child.discriminatorProp %>` key throws `KindImmutableError`. The child row is
   * found first (scoped), so a row of another kind is never touched through this repository; then the base is
   * updated — its guards (tenant, a derived column) run BEFORE anything of this table's is written, so a guard error
   * a caller swallows in its own transaction leaves nothing half written; then this table's row.
   * The base update runs whenever it has something to write<%= _child.baseTimestamps ? ' — always, because it bumps updated_at' : '' %>.
   * Returns `undefined` (as `BaseRepository.update` does) when no such row is in scope.
   */
  override async <%= m.name %>(<%= _p[0] %>: string, <%= _p[1] %>: <%= E %>Update, <%= _p[2] %>?: DrizzleTx): Promise<<%= E %>Flat> {
    if ((<%= _p[1] %> as globalThis.Record<string, unknown>)['<%= _child.discriminatorProp %>'] !== undefined) {
      throw new KindImmutableError('<%= entityName %>');
    }
    this.assertTenantWritable('update');
    const { base, own } = splitByOwner(<%= _p[1] %>, <%= _C('BASE_KEYS') %>);
    return inTransaction(this.db, <%= _p[2] %>, async (txClient) => {
      const [existing] = await this.runner(txClient)
        .select()
        .from(this.table)
        .where(this.scopeAnd(eq(this.col('id'), <%= _p[0] %>)));
      if (existing === undefined) return undefined as unknown as <%= E %>Flat;
<% if (_child.baseTimestamps) { -%>
      const baseRow = await this.baseRepo.update(<%= _p[0] %>, base, txClient);
<% } else { -%>
      const baseRow =
        globalThis.Object.keys(base).length > 0
          ? await this.baseRepo.update(<%= _p[0] %>, base, txClient)
          : (await this.runner(txClient).select().from(<%= _C('BASE') %>).where(eq(<%= _C('BASE') %>.id, <%= _p[0] %>)))[0];
<% } -%>
      if (globalThis.Object.keys(own).length === 0) return this.flat(existing, baseRow as <%= _child.baseClass %>);
      const [childRow] = await this.runner(txClient)
        .update(this.table)
        .set(this.deriveColumns(own, 'update'))
        .where(this.scopeAnd(eq(this.col('id'), <%= _p[0] %>)))
        .returning();
      return this.flat(childRow, baseRow as <%= _child.baseClass %>);
    });
  }

<%_ } else if (m.kind === 'pair_delete') { _%>
<%_ const _p = m.params.map((x) => x.name); _%>
  /**
   * Delete the pair by deleting the base row (RFC-0006 §4.1): hard — the FK cascade removes this row; soft — the
   * base's `deleted_at` is set and this row leaves scope through the `EXISTS`. A no-op for an id that is not
   * a <%= entityName %> in scope, so a row of another kind is never deleted through this repository.
   */
  override async <%= m.name %>(<%= _p[0] %>: string, <%= _p[1] %>?: DrizzleTx): Promise<void> {
    return inTransaction(this.db, <%= _p[1] %>, async (txClient) => {
      const own = await this.runner(txClient)
        .select({ id: this.col('id') })
        .from(this.tableRef)
        .where(this.scopeAnd(eq(this.col('id'), <%= _p[0] %>)));
      if (own[0] === undefined) return;
      await this.baseRepo.delete(<%= _p[0] %>, txClient);
    });
  }

<%_ } else if (m.kind === 'kind_guard') { _%>
<%_ const _p = m.params.map((x) => x.name); _%>

  // ═══════════════════════════════════════════════════════════════════════
  // Writes through the base (RFC-0006 §4.1, #875)
  // ═══════════════════════════════════════════════════════════════════════

  /** Refuses a `<%= familyBase.discriminatorProp %>` key: a row does not change kind. The database refuses it for any row with a child. */
  override async <%= m.name %>(<%= _p[0] %>: string, <%= _p[1] %>: globalThis.Partial<<%= E %>>, <%= _p[2] %>?: DrizzleTx): Promise<<%= E %>> {
    if (<%= _p[1] %>.<%= familyBase.discriminatorProp %> !== undefined) throw new KindImmutableError('<%= entityName %>');
    return super.update(<%= _p[0] %>, <%= _p[1] %>, <%= _p[2] %>);
  }
<%_ } else if (m.kind === 'create_guard') { _%>
<%_ const _p = m.params.map((x) => x.name); _%>

  /** A kind with a child table is created through the child (`KindRequiresChildError`); a base-only kind is created here. */
  override async <%= m.name %>(<%= _p[0] %>: globalThis.Partial<<%= E %>>, <%= _p[1] %>?: DrizzleTx, <%= _p[2] %>?: PairWrite): Promise<<%= E %>> {
    assertBaseOnlyKind('<%= entityName %>', <%= _p[0] %>.<%= familyBase.discriminatorProp %>, <%= _C('CHILD_CREATE_PATH') %>, <%= _p[2] %>);
    return super.create(<%= _p[0] %>, <%= _p[1] %>);
  }
<%_ } else if (m.kind === 'upsert_through_base') { _%>
<%_ const _p = m.params.map((x) => x.name); _%>
  /**
   * Upsert the pair on the base's natural key (RFC-0006 §4.2): the base row on its declared key, then this row on
   * `id`, in one transaction. `SET` carries the columns the input carries (a key left out is left alone, an
   * explicit `null` clears) and never the key, the kind, the tenant or `created_at`. A natural key that exists
   * under another kind throws `KindMismatchError`, and writes nothing.
   *
   * `created` is THIS table's: whether the <%= entityName %> row was inserted. `baseCreated` is the base's. They differ
   * when a base row exists with no child row (an orphan): the upsert repairs it, and that is a created <%= entityName %>
   * under an updated <%= _child.baseName %>.
   */
  async <%= m.name %>(
    <%= _p[0] %>: <%= E %>Create,
    <%= _p[1] %>?: DrizzleTx,
  ): Promise<{ row: <%= E %>Flat; created: boolean; baseCreated: boolean }> {
    const { base, own } = splitByOwner(<%= _p[0] %>, <%= _C('BASE_KEYS') %>);
    this.assertOwnKind(base);
    return inTransaction(this.db, <%= _p[1] %>, async (txClient) => {
      const { row: baseRow, created: baseCreated } = await this.baseRepo.upsertByNaturalKey(
        { ...base, <%= _child.discriminatorProp %>: '<%= _child.as %>' },
        txClient,
        PAIR_WRITE,
      );
      const set = this.deriveColumns(upsertSet(own, new globalThis.Set<string>()), 'update');
      const [written] = await this.runner(txClient)
        .insert(this.table)
        .values(this.childValues({ ...own, id: baseRow.id<% if (childTenantProp) { %>, <%= childTenantProp %>: baseRow.<%= childTenantProp %><% } %> }))
        .onConflictDoUpdate({
          target: this.col('id'),
          // Nothing of the child's own to set: a no-op update, so RETURNING still yields the row.
          set: globalThis.Object.keys(set).length > 0 ? set : { id: sql`${this.col('id')}` },
        })
        .returning({ ...getTableColumns(this.table), upsertCreated: sql<boolean>`(xmax = 0)` });
      const { upsertCreated, ...childRow } = written as globalThis.NonNullable<typeof written>;
      return { row: this.flat(childRow as <%= E %>, baseRow), created: upsertCreated, baseCreated };
    });
  }
<%_ } else if (m.kind === 'upsert_own') { _%>
<%_ const _p = m.params.map((x) => x.name); _%>

  /**
   * One statement, `INSERT … ON CONFLICT (<%= naturalKey.props.join(', ') %>) DO UPDATE` (RFC-0006 §4.2): the natural key
   * is the declared `natural_key` index, tenant-prefixed, so one tenant's upsert never touches another's row.
   * `SET` carries the columns the input carries plus `updated_at` — never the key, the kind, the tenant, the natural
   * key's columns or `created_at`; a key left out is left alone, an explicit `null` clears. A soft-deleted match is
   * updated and stays deleted. `created` is true when the row was inserted (`xmax = 0`).
<%_ if (_discProp) { _%>
   * A row with this key under ANOTHER kind is not updated: the conflict's `WHERE` fails, nothing is written, and
   * `KindMismatchError` is thrown — whether or not the caller owns the transaction.
<%_ } _%>
<%_ if (hasUserTracking) { _%>
   * The user axis scopes the write like every other (charter I3): the conflict's `WHERE` carries the ambient user
   * predicate, so a caller never overwrites another user's row, and the user column is never SET. A row that exists
   * but is out of scope throws `OutOfScopeWriteError`.
<%_ } _%>
   */
  async <%= m.name %>(
    <%= _p[0] %>: globalThis.Partial<<%= E %>>,
    <%= _p[1] %>?: DrizzleTx,
<%_ if (_createGuard) { _%>
    <%= _p[2] %>?: PairWrite,
<%_ } _%>
  ): Promise<{ row: <%= E %>; created: boolean }> {
<%_ if (_createGuard) { _%>
    assertBaseOnlyKind('<%= entityName %>', <%= _p[0] %>.<%= _discProp %>, <%= _C('CHILD_CREATE_PATH') %>, <%= _p[2] %>);
<%_ } _%>
    const carried = <%= _p[0] %> as globalThis.Record<string, unknown>;
    const values = this.deriveColumns(this.stampTenant(this.withTimestamps(carried, 'create')), 'create');
    const set = this.deriveColumns(this.withTimestamps(upsertSet(carried, <%= _C('UPSERT_NEVER') %>), 'update'), 'update');
<%_ if (_upsertGuarded) { _%>
    const conflictWhere = and(
<%_ if (_discProp) { _%>
      eq(this.col('<%= _discProp %>'), sql`excluded.${sql.identifier(this.col('<%= _discProp %>').name)}`),
<%_ } _%>
<%_ if (hasUserTracking) { _%>
      this.scopePredicate(),
<%_ } _%>
    );
<%_ } _%>
    const rows = await this.runner(<%= _p[1] %>)
      .insert(this.tableRef)
      .values(values)
      .onConflictDoUpdate({
        target: <%= _C('NATURAL_KEY') %>.map((key) => this.col(key)),
        set: globalThis.Object.keys(set).length > 0 ? set : { id: sql`${this.col('id')}` },
<%_ if (_upsertGuarded) { _%>
        setWhere: conflictWhere,
<%_ } _%>
      })
      .returning({ ...getTableColumns(this.tableRef), upsertCreated: sql<boolean>`(xmax = 0)` });
    const [written] = rows;
<%_ if (_upsertGuarded) { _%>
    if (written === undefined) {
<%_ if (_discProp && hasUserTracking) { _%>
      // The conflict's WHERE refused the update — the kind or the user axis. ONE read of the conflicting row says which.
      const [existing] = await this.runner(<%= _p[1] %>)
        .select({ kind: this.col('<%= _discProp %>') })
        .from(this.tableRef)
        .where(and(...<%= _C('NATURAL_KEY') %>.map((key) => eq(this.col(key), values[key]))));
      if (existing !== undefined && existing['kind'] !== values['<%= _discProp %>']) {
        throw new KindMismatchError('<%= entityName %>', globalThis.String(values['<%= _discProp %>']));
      }
      throw new OutOfScopeWriteError('<%= entityName %>');
<%_ } else if (_discProp) { _%>
      // The conflict's WHERE refused the update: the row exists under another kind.
      throw new KindMismatchError('<%= entityName %>', globalThis.String(values['<%= _discProp %>']));
<%_ } else { _%>
      throw new OutOfScopeWriteError('<%= entityName %>');
<%_ } _%>
    }
<%_ } _%>
    const { upsertCreated, ...row } = written as globalThis.NonNullable<typeof written>;
    return { row: row as unknown as <%= E %>, created: upsertCreated };
  }
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
<%_ if (i === _lastRead) { _%>
<%_ if (_derived) { _%>

  // ═══════════════════════════════════════════════════════════════════════
  // Derived `match:` columns (RFC-0006 §2.4)
  //
  // <%- matchFills.map((f) => `\`${f.key}\``).join(', ') %> <%= matchFills.length > 1 ? 'are' : 'is' %> a copy of a column of a parent row, never client input: every insert and update
  // fills it with a scalar subquery on the parent's primary key, in the same statement. A missing parent
  // derives NULL, which the column's NOT NULL (or the match CHECK) refuses (SQLSTATE 23502).
  // ═══════════════════════════════════════════════════════════════════════

  protected override deriveColumns(
    data: globalThis.Record<string, unknown>,
    mode: 'create' | 'update',
  ): globalThis.Record<string, unknown> {
    return fillDerivedColumns('<%= entityName %>', data, mode, <%= _C('DERIVED') %>);
  }
<%_ } _%>
<%_ } _%>
<%_ if ((_isRead(m) || _isWrite(m)) && !(i + 1 < _methods.length && (_isRead(_methods[i + 1]) || _isWrite(_methods[i + 1])))) { _%>
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
