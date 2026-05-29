import type { AnyRoute } from '@tanstack/react-router'
import { Schema } from 'effect'

/**
 * Typed access to a route's already-validated search params.
 *
 * The route's `validateSearch` decodes the URL search with `schema` at
 * the router boundary, so the value is correct at runtime. But inside a
 * generic `<TParent extends AnyRoute>` route factory, `route.useSearch()`
 * collapses to `any` (the parent's search is the opaque `AnyRoute`
 * constraint). This re-applies the schema's *type* to that value —
 * `as Schema.Schema.Type<typeof schema>` — so the component's view of the
 * search stays coupled to the same schema that decoded it. There is no
 * second decode, which would re-run any encode/decode transform.
 */
export const useRouteSearch = <A, I>(route: AnyRoute, schema: Schema.Schema<A, I>): A =>
  Schema.decodeUnknownSync(schema)(route.useSearch())
