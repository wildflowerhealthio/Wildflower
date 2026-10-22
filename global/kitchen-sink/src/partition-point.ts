/**
 * The index of the first element of `sorted` for which `isBefore` is false —
 * or `sorted.length` when it holds for every element. Binary search, so
 * `O(log n)` calls to `isBefore`.
 *
 * @param sorted - Partitioned by `isBefore`: every element it holds for comes
 *   before every element it doesn't, as in an array sorted by the key the
 *   predicate compares.
 * @param isBefore - Whether an element sits before the point being sought.
 *
 * @remarks
 * The name and contract are Rust's `slice::partition_point` (C++'s
 * `std::partition_point`). One predicate covers both bounds of a sorted
 * array: `(a) => a < target` finds the first element at or past `target`
 * (a lower bound), `(a) => a <= target` the first element past it (an upper
 * bound). Effect's `Array` module has no binary search to reach for.
 *
 * When `sorted` isn't partitioned by `isBefore`, the result is some index in
 * `0..sorted.length`, but which one is unspecified.
 *
 * @example
 * ```ts
 * partitionPoint([1, 3, 3, 5], (n) => n < 3) // 1
 * partitionPoint([1, 3, 3, 5], (n) => n <= 3) // 3
 * ```
 */
const partitionPoint = <A>(sorted: ReadonlyArray<A>, isBefore: (element: A) => boolean): number => {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (isBefore(sorted[middle])) low = middle + 1
    else high = middle
  }
  return low
}

export { partitionPoint }
