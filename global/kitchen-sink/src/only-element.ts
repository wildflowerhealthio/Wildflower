import { Array, Option } from 'effect'

/** The element of `items` when it holds exactly one; `None` when it is empty or holds several. */
const onlyElement = <A>(items: readonly A[]): Option.Option<A> =>
  items.length === 1 ? Array.head(items) : Option.none()

export { onlyElement }
