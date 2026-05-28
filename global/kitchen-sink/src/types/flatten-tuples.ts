// oxlint-disable typescript/no-explicit-any
type flattenTuples<T extends ReadonlyArray<ReadonlyArray<any>>> = T extends readonly []
  ? readonly []
  : T extends readonly [
        infer Head extends ReadonlyArray<any>,
        ...infer Rest extends ReadonlyArray<ReadonlyArray<any>>,
      ]
    ? readonly [...Head, ...flattenTuples<Rest>]
    : never

const flattenTuples = <const T extends ReadonlyArray<ReadonlyArray<any>>>(
  tuples: T
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
): flattenTuples<T> => tuples.flatMap((tuple) => tuple, []) as flattenTuples<T>

export { flattenTuples }
