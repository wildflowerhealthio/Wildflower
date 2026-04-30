import {
  Events,
  type EventDef,
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

type DomainResourceTable<
  RT extends string,
  RowSchema extends Schema.Schema.AnyNoContext,
> = State.SQLite.TableDef<
  State.SQLite.DefaultSqliteTableDef & { readonly name: RT },
  State.SQLite.TableOptions,
  RowSchema
>

type DomainResourceUpsertEvent<
  RT extends string,
  RowSchema extends Schema.Schema.AnyNoContext,
> = EventDef<
  `v1.${RT}Upserted`,
  { readonly resource: Schema.Schema.Type<RowSchema> },
  { readonly resource: Schema.Schema.Encoded<RowSchema> }
>

type DomainResourceDeleteEvent<RT extends string> = EventDef<
  `v1.${RT}Deleted`,
  { readonly id: string },
  { readonly id: string }
>

type DomainResourceEvents<RT extends string, RowSchema extends Schema.Schema.AnyNoContext> = {
  upsert: DomainResourceUpsertEvent<RT, RowSchema>
  deleteById: DomainResourceDeleteEvent<RT>
}

type DomainResourceMaterializers<
  RT extends string,
  RowSchema extends Schema.Schema.AnyNoContext,
> = ReturnType<typeof materializers<DomainResourceEvents<RT, RowSchema>>>

type DomainResourcePersistenceResult<
  RT extends string,
  RowSchema extends Schema.Schema.AnyNoContext,
  TableRowSchema extends Schema.Schema.AnyNoContext,
> = {
  events: DomainResourceEvents<RT, RowSchema>
  materializers: DomainResourceMaterializers<RT, RowSchema>
  queries: {
    all$: Queryable<readonly Schema.Schema.Type<RowSchema>[]>
    getById$: (id: string) => Queryable<Schema.Schema.Type<RowSchema> | undefined>
    search$: (params: {
      readonly where?: QueryBuilder.WhereParams<DomainResourceTable<RT, TableRowSchema>>
      readonly limit?: number
      readonly offset?: number
    }) => Queryable<readonly Schema.Schema.Type<RowSchema>[]>
    count$: (params: {
      readonly where?: QueryBuilder.WhereParams<DomainResourceTable<RT, TableRowSchema>>
    }) => Queryable<number>
  }
}

export type {
  DomainResourceDeleteEvent,
  DomainResourceMaterializers,
  DomainResourcePersistenceResult,
  DomainResourceTable,
  DomainResourceUpsertEvent,
}

export function makeDomainResourcePersistence<
  const RT extends string,
  TableRowSchema extends Schema.Schema.AnyNoContext,
  ExplicitRowSchema extends Schema.Schema.AnyNoContext,
>(args: {
  readonly table: DomainResourceTable<RT, TableRowSchema>
  readonly rowSchema: ExplicitRowSchema
}): DomainResourcePersistenceResult<RT, ExplicitRowSchema, TableRowSchema> {
  const { table, rowSchema } = args
  const resourceType = table.sqliteDef.name

  const validateRow = Schema.validateSync(rowSchema)

  const decodeInsertResource: (resource: unknown) => Parameters<typeof table.insert>[0] =
    Schema.decodeUnknownSync(Schema.typeSchema(table.insertSchema))
  type ConflictTarget = Parameters<ReturnType<typeof table.insert>['onConflict']>[0]
  type ByIdWhere = QueryBuilder.WhereParams<typeof table>
  /* oxlint-disable-next-line typescript/no-unsafe-type-assertion */
  const idConflictColumn = 'id' as unknown as ConflictTarget
  const byId = (id: string): ByIdWhere =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    ({ id }) as unknown as ByIdWhere

  const upsertEventName = `v1.${resourceType}Upserted` as const
  const deleteEventName = `v1.${resourceType}Deleted` as const

  const events: DomainResourceEvents<RT, ExplicitRowSchema> = {
    upsert: Events.synced({
      name: upsertEventName,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      schema: StructNoContext({ resource: rowSchema }) as unknown as Schema.Schema<
        { resource: Schema.Schema.Type<ExplicitRowSchema> },
        { resource: Schema.Schema.Encoded<ExplicitRowSchema> },
        never
      >,
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

  const materializerHandlers = {
    [upsertEventName]: ({
      resource,
    }: typeof events.upsert.schema.Type): SingleOrReadonlyArray<MaterializerResult> =>
      table.insert(decodeInsertResource(resource)).onConflict(idConflictColumn, 'replace'),
    [deleteEventName]: ({
      id,
    }: typeof events.deleteById.schema.Type): SingleOrReadonlyArray<MaterializerResult> =>
      table.delete().where(byId(id)),
  }

  const eventMaterializers = materializers(
    events,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion typescript/no-explicit-any
    materializerHandlers as any
  )

  type SearchWhere = QueryBuilder.WhereParams<DomainResourceTable<RT, TableRowSchema>>

  const queries: DomainResourcePersistenceResult<RT, ExplicitRowSchema, TableRowSchema>['queries'] =
    {
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
        // oxlint-disable-next-line typescript/no-explicit-any
        let qb: any = table
        if (where !== undefined) {
          // oxlint-disable-next-line typescript/no-unsafe-assignment typescript/no-unsafe-call typescript/no-unsafe-member-access
          qb = qb.where(where)
        }
        if (typeof limit === 'number') {
          // oxlint-disable-next-line typescript/no-unsafe-assignment typescript/no-unsafe-call typescript/no-unsafe-member-access
          qb = qb.limit(limit)
        }
        if (typeof offset === 'number') {
          // oxlint-disable-next-line typescript/no-unsafe-assignment typescript/no-unsafe-call typescript/no-unsafe-member-access
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
