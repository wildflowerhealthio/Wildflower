import {
  Events,
  type EventDef,
  defineMaterializer,
  materializers,
  type QueryBuilder,
  queryDb,
  type State,
  type Queryable,
  type MaterializerResult,
} from '@livestore/livestore'
import type { SingleOrReadonlyArray } from '@livestore/utils'
import { Schema } from 'effect'
import { StructNoContext } from 'kitchen-sink/schema'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

type Table<
  ResourceType extends string,
  RowSchema extends Schema.Schema.AnyNoContext,
> = State.SQLite.TableDef<
  State.SQLite.DefaultSqliteTableDef & { readonly name: ResourceType },
  State.SQLite.TableOptions,
  RowSchema
>

type UpsertEvent<
  ResourceType extends string,
  RowSchema extends Schema.Schema.AnyNoContext,
> = EventDef<
  `v1.${ResourceType}Upserted`,
  { readonly resource: Schema.Schema.Type<RowSchema> },
  { readonly resource: Schema.Schema.Encoded<RowSchema> }
>

type DeleteEvent<ResourceType extends string> = EventDef<
  `v1.${ResourceType}Deleted`,
  { readonly id: string },
  { readonly id: string }
>

type EventBundle<ResourceType extends string, RowSchema extends Schema.Schema.AnyNoContext> = {
  upsert: UpsertEvent<ResourceType, RowSchema>
  deleteById: DeleteEvent<ResourceType>
}

type Materializers<
  ResourceType extends string,
  RowSchema extends Schema.Schema.AnyNoContext,
> = ReturnType<typeof materializers<EventBundle<ResourceType, RowSchema>>>

type PersistenceResult<
  ResourceType extends string,
  RowSchema extends Schema.Schema.AnyNoContext,
  TableRowSchema extends Schema.Schema.AnyNoContext,
> = {
  events: EventBundle<ResourceType, RowSchema>
  materializers: Materializers<ResourceType, RowSchema>
  queries: {
    all$: Queryable<readonly Schema.Schema.Type<RowSchema>[]>
    getById$: (id: string) => Queryable<Schema.Schema.Type<RowSchema> | undefined>
    search$: (params: {
      readonly where?: QueryBuilder.WhereParams<Table<ResourceType, TableRowSchema>>
      readonly limit?: number
      readonly offset?: number
    }) => Queryable<readonly Schema.Schema.Type<RowSchema>[]>
    count$: (params: {
      readonly where?: QueryBuilder.WhereParams<Table<ResourceType, TableRowSchema>>
    }) => Queryable<number>
  }
}

export type {
  DeleteEvent,
  EventBundle as Events,
  Materializers,
  PersistenceResult,
  Table,
  UpsertEvent,
}

// ---------------------------------------------------------------------------
// Implementation helpers
// ---------------------------------------------------------------------------

/**
 * Build the wire schema for an `Upserted` event. `StructNoContext({ resource })`
 * produces a schema whose `.Type`/`.Encoded` are structurally identical to the
 * declared `UpsertEvent.schema.Type`/`Encoded`, but TypeScript's type-equality
 * fails through the `Simplify` indirection, so we lift the cast here behind a
 * named helper. The cast is sound: the runtime shape is a one-field struct
 * keyed `resource`, and both sides agree on the `Type`/`Encoded` of that field.
 */
const upsertEventSchemaFor = <RowSchema extends Schema.Schema.AnyNoContext>(
  rowSchema: RowSchema
): Schema.Schema<
  { readonly resource: Schema.Schema.Type<RowSchema> },
  { readonly resource: Schema.Schema.Encoded<RowSchema> },
  never
> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see helper docstring above
  StructNoContext({ resource: rowSchema }) as unknown as Schema.Schema<
    { readonly resource: Schema.Schema.Type<RowSchema> },
    { readonly resource: Schema.Schema.Encoded<RowSchema> },
    never
  >

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makeDomainResourcePersistence<
  const ResourceType extends string,
  TableRowSchema extends Schema.Schema.AnyNoContext,
  ExplicitRowSchema extends Schema.Schema.AnyNoContext,
>(args: {
  readonly table: Table<ResourceType, TableRowSchema>
  readonly rowSchema: ExplicitRowSchema
}): PersistenceResult<ResourceType, ExplicitRowSchema, TableRowSchema> {
  const { table, rowSchema } = args
  const resourceType = table.sqliteDef.name

  const validateRow = Schema.validateSync(rowSchema)

  const decodeInsertResource: (resource: unknown) => Parameters<typeof table.insert>[0] =
    Schema.decodeUnknownSync(Schema.typeSchema(table.insertSchema))

  type ConflictTarget = Parameters<ReturnType<typeof table.insert>['onConflict']>[0]
  type ByIdWhere = QueryBuilder.WhereParams<typeof table>

  // The `id` column is declared on every domain-resource table, but the table's
  // generic type-parameters don't carry a hook that lets us derive the literal
  // `'id'` `ConflictTarget`. Stay narrow with the column name and lift the cast
  // here so callers below read as plain `idConflictColumn`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment
  const idConflictColumn = 'id' as unknown as ConflictTarget

  // Same shape rationale as `idConflictColumn`: we know `id` is the column;
  // the `WhereParams` generic just doesn't expose it for generic tables.
  const byId = (id: string): ByIdWhere =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment
    ({ id }) as unknown as ByIdWhere

  const upsertEventName = `v1.${resourceType}Upserted` as const
  const deleteEventName = `v1.${resourceType}Deleted` as const

  const events: EventBundle<ResourceType, ExplicitRowSchema> = {
    upsert: Events.synced({
      name: upsertEventName,
      schema: upsertEventSchemaFor(rowSchema),
    }),
    deleteById: Events.synced<
      typeof deleteEventName,
      { readonly id: string },
      { readonly id: string }
    >({
      name: deleteEventName,
      schema: StructNoContext({ id: Schema.String }),
    }),
  }

  // `defineMaterializer` types each handler against its event def (so the
  // event arg destructuring is checked). Assembling them into a record keyed
  // by computed event-name strings widens the keys back to `string`, so the
  // assembled record needs an outer cast to land in the `Materializers` shape.
  const upsertHandler = defineMaterializer(
    events.upsert,
    ({ resource }): SingleOrReadonlyArray<MaterializerResult> =>
      table.insert(decodeInsertResource(resource)).onConflict(idConflictColumn, 'replace')
  )
  const deleteHandler = defineMaterializer(
    events.deleteById,
    ({ id }): SingleOrReadonlyArray<MaterializerResult> => table.delete().where(byId(id))
  )
  const materializerHandlers = {
    [upsertEventName]: upsertHandler,
    [deleteEventName]: deleteHandler,
  }
  type MaterializerMap = Parameters<
    typeof materializers<EventBundle<ResourceType, ExplicitRowSchema>>
  >[1]
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the per-handler types are checked above; this cast only re-narrows the computed-key record back to literal-key form.
  const typedHandlers = materializerHandlers as unknown as MaterializerMap
  const eventMaterializers = materializers(events, typedHandlers)

  type SearchWhere = QueryBuilder.WhereParams<Table<ResourceType, TableRowSchema>>

  const queries: PersistenceResult<ResourceType, ExplicitRowSchema, TableRowSchema>['queries'] = {
    all$: queryDb(table, {
      map: (rows): readonly Schema.Schema.Type<ExplicitRowSchema>[] =>
        rows.map((row) => validateRow(row)),
      label: `${resourceType}.all`,
    }),
    getById$: (id: string) =>
      queryDb(table.where(byId(id)), {
        map: (rows): Schema.Schema.Type<ExplicitRowSchema> | undefined => {
          const row = rows[0]
          if (!row) {
            return undefined
          }
          return validateRow(row)
        },
        label: `${resourceType}.getById`,
      }),
    search$: ({ where, limit, offset }) => {
      // The QueryBuilder's `.where`/`.limit`/`.offset` methods narrow the type
      // through the `TWithout` phantom param, so each chained call returns a
      // structurally-different QueryBuilder type. We accumulate into `any`
      // because the inferred chain type isn't useful here — `queryDb` accepts
      // any QueryBuilder and the result schema is enforced by `map`.
      // oxlint-disable-next-line typescript/no-explicit-any -- see comment
      let qb: any = table
      if (where !== undefined) {
        // oxlint-disable-next-line typescript/no-unsafe-assignment typescript/no-unsafe-call typescript/no-unsafe-member-access -- see qb declaration above
        qb = qb.where(where)
      }
      if (typeof limit === 'number') {
        // oxlint-disable-next-line typescript/no-unsafe-assignment typescript/no-unsafe-call typescript/no-unsafe-member-access -- see qb declaration above
        qb = qb.limit(limit)
      }
      if (typeof offset === 'number') {
        // oxlint-disable-next-line typescript/no-unsafe-assignment typescript/no-unsafe-call typescript/no-unsafe-member-access -- see qb declaration above
        qb = qb.offset(offset)
      }
      return queryDb(qb, {
        map: (rows: readonly unknown[]): readonly Schema.Schema.Type<ExplicitRowSchema>[] =>
          rows.map((row) => validateRow(row)),
        label: `${resourceType}.search`,
      })
    },
    count$: ({ where }: { readonly where?: SearchWhere }) => {
      const base = table.count()
      let qb = base
      if (where !== undefined) {
        qb = base.where(where)
      }
      return queryDb(qb, {
        map: (n): number => n,
        label: `${resourceType}.count`,
      })
    },
  }

  return {
    events,
    materializers: eventMaterializers,
    queries,
  }
}
