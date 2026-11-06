/**
 * Titled sections of entries: the one container every stage of an import
 * carries its records in, from a binding's decode to the write.
 *
 * @remarks
 * Section order is meaning: the review lists a file set's source files first
 * and its implied records last, so every function here keeps the order of
 * sections and of the entries in each, and {@link combine} never merges two
 * sections that share a title.
 *
 * {@link map} keeps reference identity: a section `f` returns every entry of
 * as itself comes back as the same section object, and a container none of
 * whose sections changed comes back as itself. A memoized row, and a resolve
 * pass that tells whether anything moved by comparing objects, rely on it.
 *
 * @packageDocumentation
 */
import { Array as Arr, Effect, Option, type Predicate, type Types } from 'effect'

/** A titled group of entries, reviewed under its title. */
interface Section<E> {
  readonly title: string
  readonly entries: readonly E[]
}

/** Sections of entries, in review order. */
interface Type<E> {
  readonly sections: readonly Section<E>[]
}

/** No sections. */
const empty = <E>(): Type<E> => ({ sections: [] })

/** One section of `entries` under `title`. */
const of = <E>(title: string, entries: readonly E[]): Type<E> => ({
  sections: [{ title, entries }],
})

/**
 * `sectioned` with `f` applied to every entry, sections and their titles kept.
 *
 * @remarks
 * A section whose every entry `f` returns as itself comes back as the same
 * object, and `sectioned` comes back as itself when every section does.
 */
const map = <A, B>(sectioned: Type<A>, f: (entry: A) => B): Type<B> => {
  const sections = sectioned.sections.map((section): Section<B> => {
    const entries = section.entries.map(f)
    return isSectionOf(section, entries) ? section : { title: section.title, entries }
  })
  return isSectionedOf(sectioned, sections) ? sectioned : { sections }
}

/** Whether `before` holds the very values `after` does, at every position. */
const holdsSame = (before: readonly unknown[], after: readonly unknown[]): boolean =>
  before.length === after.length && before.every((value, at) => Object.is(value, after[at]))

/**
 * Whether `section` holds the very entries `entries` does: where it does, it
 * is a section of their type too, which is what lets {@link map} give back a
 * section `f` changed nothing in as itself.
 */
const isSectionOf = <A, B>(section: Section<A>, entries: readonly B[]): section is Section<A & B> =>
  holdsSame(section.entries, entries)

/** {@link isSectionOf} for a whole container and the sections {@link map} built for it. */
const isSectionedOf = <A, B>(
  sectioned: Type<A>,
  sections: readonly Section<B>[]
): sectioned is Type<A> & Type<B> => holdsSame(sectioned.sections, sections)

/** `sectioned` with each entry `f` returns `Some` for replaced by its value, and a section left empty dropped. */
const filterMap = <A, B>(sectioned: Type<A>, f: (entry: A) => Option.Option<B>): Type<B> => ({
  sections: Arr.filterMap(sectioned.sections, ({ title, entries }) =>
    Option.map(
      Option.liftPredicate(Arr.filterMap(entries, f), Arr.isNonEmptyReadonlyArray),
      (kept) => ({
        title,
        entries: kept,
      })
    )
  ),
})

/** `sectioned` with only the entries `predicate` holds for, and a section left empty dropped. */
const filter = <A>(sectioned: Type<A>, predicate: Predicate.Predicate<A>): Type<A> =>
  filterMap(sectioned, Option.liftPredicate(predicate))

/** {@link map} with an effect: every entry through `f`, in section and entry order. */
const forEach = <A, B, E, R>(
  sectioned: Type<A>,
  f: (entry: A) => Effect.Effect<B, E, R>,
  options?: { readonly concurrency?: Types.Concurrency | undefined }
): Effect.Effect<Type<B>, E, R> =>
  Effect.map(
    Effect.forEach(
      sectioned.sections,
      ({ title, entries }) =>
        Effect.map(Effect.forEach(entries, f, options), (mapped): Section<B> => ({
          title,
          entries: mapped,
        })),
      options
    ),
    (sections) => ({ sections })
  )

/** Every entry of `sectioned`, in section order. */
const entries = <E>(sectioned: Type<E>): readonly E[] =>
  sectioned.sections.flatMap((section) => section.entries)

/**
 * `ungrouped` in one section per title `titleOf` gives, the sections in the
 * order each title first appears and each section's entries in theirs.
 *
 * @remarks
 * A `Map` rather than `Array.groupBy`'s record, which hoists integer-like keys
 * ahead of the rest in numeric order.
 */
const groupBy = <E>(ungrouped: Iterable<E>, titleOf: (entry: E) => string): Type<E> => {
  const byTitle = new Map<string, E[]>()
  for (const entry of ungrouped) {
    const title = titleOf(entry)
    const section = byTitle.get(title)
    if (section === undefined) byTitle.set(title, [entry])
    else section.push(entry)
  }
  return { sections: Array.from(byTitle, ([title, grouped]) => ({ title, entries: grouped })) }
}

/** `first`'s sections, then `second`'s: two sections that share a title stay two. */
const combine = <E>(first: Type<E>, second: Type<E>): Type<E> => ({
  sections: [...first.sections, ...second.sections],
})

/** Every container's sections, in order ({@link combine}). */
const combineAll = <E>(all: Iterable<Type<E>>): Type<E> => ({
  sections: Arr.flatMap(Arr.fromIterable(all), (one) => one.sections),
})

/** `section` ahead of `sectioned`'s sections. */
const prepend = <E>(sectioned: Type<E>, section: Section<E>): Type<E> => ({
  sections: [section, ...sectioned.sections],
})

/** `section` after `sectioned`'s sections. */
const append = <E>(sectioned: Type<E>, section: Section<E>): Type<E> => ({
  sections: [...sectioned.sections, section],
})

export {
  append,
  combine,
  combineAll,
  empty,
  entries,
  filter,
  filterMap,
  forEach,
  groupBy,
  map,
  of,
  prepend,
}
export type { Section, Type }
