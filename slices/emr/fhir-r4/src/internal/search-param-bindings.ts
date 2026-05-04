import type { QueryBuilder, State } from '@livestore/livestore'
import type { Schema } from 'effect'

interface BaseSearchParams {
  readonly _count?: number | undefined
  readonly _pageToken?: string | undefined
}

interface SearchParamBindings<
  SearchParamsType extends BaseSearchParams,
  Table extends State.SQLite.TableDefBase,
> {
  readonly SearchParams: Schema.Schema<SearchParamsType, Record<string, string | undefined>>
  readonly buildWhere: (params: SearchParamsType) => QueryBuilder.WhereParams<Table> | undefined
}

export type { BaseSearchParams, SearchParamBindings }
