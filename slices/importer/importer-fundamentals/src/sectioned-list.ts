/**
 * Titled sections of rows: the one container every stage of an import
 * carries its records in, from a binding's decode to the write.
 *
 * @remarks
 * Section order is meaning: the review lists a file set's source files first
 * and its implied records last, so every function here keeps the order of
 * sections and of the rows in each, and {@link concatenate} never merges two
 * sections that share a title.
 *
 * {@link map} keeps reference identity: a section `f` returns every row of
 * as itself comes back as the same section object, and a list none of whose
 * sections changed comes back as itself. A memoized row, and a resolve pass
 * that tells whether anything moved by comparing objects, rely on it.
 *
 * @packageDocumentation
 */
import { Array as Arr, Effect, Option, type Predicate, type Types } from 'effect'

import * as Section from './section.ts'

/** Sections of rows, in review order. */
interface Type<E> {
  readonly sections: readonly Section.Type<E>[]
}

/** No sections. */
const empty = <E>(): Type<E> => ({ sections: [] })

/** `sections`, in the order given. */
const make = <E>(sections: readonly Section.Type<E>[]): Type<E> => ({ sections })

/**
 * Whether `before`'s `key` holds the very values `after` does, at every
 * position: where it does, `before` is already what {@link map} would build
 * from `after`, so map gives it back as itself.
 */
const holdsSame = <K extends PropertyKey, V>(
  before: Readonly<Record<K, readonly unknown[]>>,
  key: K,
  after: readonly V[]
): before is Readonly<Record<K, readonly V[]>> =>
  before[key].length === after.length &&
  before[key].every((value, at) => Object.is(value, after[at]))

/**
 * `list` with `f` applied to every row, sections and their titles kept.
 *
 * @remarks
 * A section whose every row `f` returns as itself comes back as the same
 * object, and `list` comes back as itself when every section does.
 */
const map = <A, B>(list: Type<A>, f: (row: A) => B): Type<B> => {
  const sections = list.sections.map((section): Section.Type<B> => {
    const rows = section.rows.map(f)
    return holdsSame(section, 'rows', rows) ? section : Section.make(section.title, rows)
  })
  return holdsSame(list, 'sections', sections) ? list : make(sections)
}

/** `list` with each row `f` returns `Some` for replaced by its value, and a section left empty dropped. */
const filterMap = <A, B>(list: Type<A>, f: (row: A) => Option.Option<B>): Type<B> =>
  make(
    Arr.filterMap(list.sections, ({ title, rows }) =>
      Option.map(
        Option.liftPredicate(Arr.filterMap(rows, f), Arr.isNonEmptyReadonlyArray),
        (kept) => Section.make(title, kept)
      )
    )
  )

/** `list` with only the rows `predicate` holds for, and a section left empty dropped. */
const filter = <A>(list: Type<A>, predicate: Predicate.Predicate<A>): Type<A> =>
  filterMap(list, Option.liftPredicate(predicate))

/** {@link map} with an effect: every row through `f`, in section and row order. */
const forEach = <A, B, E, R>(
  list: Type<A>,
  f: (row: A) => Effect.Effect<B, E, R>,
  options?: { readonly concurrency?: Types.Concurrency | undefined }
): Effect.Effect<Type<B>, E, R> =>
  Effect.map(
    Effect.forEach(
      list.sections,
      ({ title, rows }) =>
        Effect.map(Effect.forEach(rows, f, options), (mapped) => Section.make(title, mapped)),
      options
    ),
    make
  )

/** Every row of `list`, in section order. */
const rows = <E>(list: Type<E>): readonly E[] => list.sections.flatMap((section) => section.rows)

/**
 * `ungrouped` in one section per title `titleOf` gives, the sections in the
 * order each title first appears and each section's rows in theirs.
 *
 * @remarks
 * A `Map` rather than `Array.groupBy`'s record, which hoists integer-like keys
 * ahead of the rest in numeric order.
 */
const groupBy = <E>(ungrouped: Iterable<E>, titleOf: (row: E) => string): Type<E> => {
  const byTitle = new Map<string, E[]>()
  for (const row of ungrouped) {
    const title = titleOf(row)
    const section = byTitle.get(title)
    if (section === undefined) byTitle.set(title, [row])
    else section.push(row)
  }
  return make(Array.from(byTitle, ([title, grouped]) => Section.make(title, grouped)))
}

/** Every list's sections, in order: two sections that share a title stay two. */
const concatenateAll = <E>(all: Iterable<Type<E>>): Type<E> =>
  make(Arr.flatMap(Arr.fromIterable(all), (one) => one.sections))

/** `first`'s sections, then `second`'s ({@link concatenateAll}). */
const concatenate = <E>(first: Type<E>, second: Type<E>): Type<E> => concatenateAll([first, second])

/** `section` ahead of `list`'s sections. */
const prepend = <E>(list: Type<E>, section: Section.Type<E>): Type<E> =>
  make([section, ...list.sections])

/** `section` after `list`'s sections. */
const append = <E>(list: Type<E>, section: Section.Type<E>): Type<E> =>
  make([...list.sections, section])

export {
  append,
  concatenate,
  concatenateAll,
  empty,
  filter,
  filterMap,
  forEach,
  groupBy,
  make,
  map,
  prepend,
  rows,
}
export type { Type }
