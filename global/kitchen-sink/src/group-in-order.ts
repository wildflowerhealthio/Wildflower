import { type Array as Arr, MutableHashMap, Option } from 'effect'

/** The items sharing one key, in the order they were given. */
interface Group<K, A> {
  readonly key: K
  readonly items: Arr.NonEmptyReadonlyArray<A>
}

/**
 * `items` grouped by `keyOf`, the groups in the order their first items
 * appear, each group's items in the order given.
 *
 * @remarks
 * Keys are compared by `Equal`, so a key may be any value: a `Data` struct or
 * tagged value as well as a string. `Array.groupBy` takes string keys only
 * and returns a record, which has no order to rely on.
 */
const groupInOrder = <A, K>(items: Iterable<A>, keyOf: (item: A) => K): readonly Group<K, A>[] => {
  const membersByKey = MutableHashMap.empty<K, Arr.NonEmptyArray<A>>()
  const groups: Group<K, A>[] = []
  for (const item of items) {
    const key = keyOf(item)
    Option.match(MutableHashMap.get(membersByKey, key), {
      onSome: (members) => {
        members.push(item)
      },
      onNone: () => {
        const members: Arr.NonEmptyArray<A> = [item]
        MutableHashMap.set(membersByKey, key, members)
        groups.push({ key, items: members })
      },
    })
  }
  return groups
}

export { groupInOrder }
export type { Group }
