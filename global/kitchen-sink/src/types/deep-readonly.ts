/**
 * Recursively makes every property of `T` readonly.
 *
 * @remarks
 * - Primitives (`string`, `number`, `boolean`, `symbol`, `bigint`,
 *   `null`, `undefined`) and opaque built-ins (`Date`, `RegExp`, `Map`,
 *   `Set`, `Function`) are returned as-is — they have no enumerable
 *   properties worth freezing.
 * - Arrays become `ReadonlyArray<DeepReadonly<Element>>`.
 * - All other object types are mapped with `readonly` on every key,
 *   applied recursively.
 */
type Primitive = string | number | boolean | symbol | bigint | null | undefined
// oxlint-disable-next-line @typescript-eslint/no-unsafe-function-type
type BuiltIn = Date | RegExp | Map<unknown, unknown> | Set<unknown> | Function

export type DeepReadonly<T> = T extends Primitive | BuiltIn
  ? T
  : T extends (infer A)[]
    ? readonly DeepReadonly<A>[]
    : { readonly [K in keyof T]: DeepReadonly<T[K]> }
