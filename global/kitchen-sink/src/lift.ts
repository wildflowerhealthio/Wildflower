import { Array as Arr, Option, pipe, type Predicate, Schema } from 'effect'

/**
 * Lifts: reading one value off a list, consuming the entry it came from.
 *
 * @remarks
 * A {@link Lift} is a parser over a list: it returns the value it read and the
 * list as it is without that entry, or `None` when there is nothing to read.
 * The combinators compose lifts the way a rule about the list is stated —
 * "this entry **and** that one" ({@link zipRight}), "this, **or else** that"
 * ({@link orElse}), "only an entry **whose value** satisfies…" ({@link filter})
 * — and thread the shrinking list through, so no caller handles what is left of
 * it by hand.
 *
 * A lift only ever removes **exactly the entry it read**, never every entry
 * like it: a list may hold several entries a reader would accept, and the ones
 * it did not read are not its to drop.
 */

/**
 * A value read off a list, together with the list as it is once that value's
 * entry is gone.
 *
 * @typeParam A - The value read
 * @typeParam E - The list's entry type
 */
interface Lifted<A, E> {
  /** The value the entry carried. */
  readonly value: A
  /** The list with exactly the entries read removed — every other entry kept. */
  readonly remaining: readonly E[]
}

/** Reads a value off a list of `E`, or `None` when there is none to read. */
type Lift<A, E> = (entries: readonly E[]) => Option.Option<Lifted<A, E>>

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The first entry `read` accepts, read to its value, with exactly that entry
 * removed. Later entries `read` would also accept are kept, never consulted.
 */
const first =
  <A, E>(read: (entry: E) => Option.Option<A>): Lift<A, E> =>
  (entries) =>
    pipe(
      Arr.findFirst(entries, (entry, index) =>
        Option.map(read(entry), (value) => ({ value, index }))
      ),
      Option.map(({ value, index }) => ({ value, remaining: Arr.remove(entries, index) }))
    )

/**
 * The first entry that decodes through `schema` — for a list of unvalidated
 * wire JSON, where each entry is decoded on its own and a malformed one
 * disables only itself.
 */
const firstDecoding = <A, I>(schema: Schema.Schema<A, I>): Lift<A, unknown> => {
  const decode = Schema.decodeUnknownOption(schema)
  return first((entry) => decode(entry))
}

// ---------------------------------------------------------------------------
// Combining
// ---------------------------------------------------------------------------

/**
 * A lift that succeeds only when `read` also accepts its value — and otherwise
 * reads nothing and consumes nothing.
 */
const filterMap =
  <A, B>(read: (value: A) => Option.Option<B>) =>
  <E>(self: Lift<A, E>): Lift<B, E> =>
  (entries) =>
    Option.flatMap(self(entries), ({ value, remaining }) =>
      Option.map(read(value), (accepted) => ({ value: accepted, remaining }))
    )

/** A lift that succeeds only when its value satisfies `predicate`. */
const filter = <A>(predicate: Predicate.Predicate<A>): (<E>(self: Lift<A, E>) => Lift<A, E>) =>
  filterMap(Option.liftPredicate(predicate))

/** A lift whose value is transformed by `f`; what it consumes is unchanged. */
const map =
  <A, B>(f: (value: A) => B) =>
  <E>(self: Lift<A, E>): Lift<B, E> =>
  (entries) =>
    Option.map(self(entries), ({ value, remaining }) => ({ value: f(value), remaining }))

/** `self`, or — when it reads nothing — `that`, reading the same untouched list. */
const orElse =
  <A, E>(that: Lift<A, E>) =>
  (self: Lift<A, E>): Lift<A, E> =>
  (entries) =>
    Option.orElse(self(entries), () => that(entries))

/**
 * Both lifts, in sequence: `that` reads what `self` left. Succeeds only when
 * both do, consuming both entries, and yields `that`'s value — `self` is a
 * precondition whose own value is not needed.
 */
const zipRight =
  <B, E>(that: Lift<B, E>) =>
  <A>(self: Lift<A, E>): Lift<B, E> =>
  (entries) =>
    Option.flatMap(self(entries), ({ remaining }) => that(remaining))

// ---------------------------------------------------------------------------
// Committing
// ---------------------------------------------------------------------------

/** The list with the entry `lift` reads removed, or unchanged when it reads nothing. */
const drop =
  <A, E>(lift: Lift<A, E>) =>
  (entries: readonly E[]): readonly E[] =>
    pipe(
      lift(entries),
      Option.map(({ remaining }) => remaining),
      Option.getOrElse(() => entries)
    )

export type { Lift, Lifted }
export { drop, filter, filterMap, first, firstDecoding, map, orElse, zipRight }
