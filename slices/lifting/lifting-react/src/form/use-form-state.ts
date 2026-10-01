import { Array as Arr, Option, pipe } from 'effect'
import { useState } from 'react'

/** The type of each item of a list type; `never` for a type that is not a list. */
type ItemOf<L> = L extends readonly (infer Item)[] ? Item : never

/**
 * A form's state, or one part of it, with typed setters that change it.
 *
 * @remarks
 * Every setter is an update of the state as it stands when React applies it,
 * so several in one event all land. A part's setters ({@link FormState.field},
 * {@link FormState.list}, {@link FormList.map}) write through their parent, so
 * a sub-form handed one edits its part of the whole form and nothing else.
 */
interface FormState<S> {
  /** The state as of this render. */
  readonly value: S
  /** Replaces the whole state. */
  readonly replace: (next: S) => void
  /** Changes the state by `edit`, applied to it as it stands. */
  readonly update: (edit: (current: S) => S) => void
  /** Sets the field `key`, e.g. `form.set('title', title)`. */
  readonly set: <K extends keyof S>(key: K, fieldValue: S[K]) => void
  /** The field `key` as a state of its own, its setters writing through this one. */
  readonly field: <K extends keyof S>(key: K) => FormState<S[K]>
  /**
   * The list field `key` with its list setters, e.g.
   * `form.list('days').remove(index)`; only a field holding a readonly array
   * is accepted. Call it as a method (`form.list(…)`), not detached.
   */
  list<T extends { readonly [P in K]: readonly Item[] }, K extends keyof T, Item = ItemOf<T[K]>>(
    this: FormState<T>,
    key: K
  ): FormList<Item>
}

/** A list field of a form's state, with setters by index. */
interface FormList<Item> {
  /** The items as of this render. */
  readonly items: readonly Item[]
  /** Appends `item`. */
  readonly add: (item: Item) => void
  /** Removes the item at `index`; no change when there is none. */
  readonly remove: (index: number) => void
  /** Changes the item at `index` by `edit`; no change when there is none. */
  readonly update: (index: number, edit: (item: Item) => Item) => void
  /**
   * Swaps the item at `index` with its neighbour `offset` away (`-1`
   * earlier, `1` later); no change when there is none.
   */
  readonly move: (index: number, offset: -1 | 1) => void
  /** Each item as a state of its own (its setters edit it in place), with its index. */
  readonly map: <B>(each: (item: FormState<Item>, index: number) => B) => readonly B[]
}

/** The swap {@link FormList.move} makes. */
const swapWithNeighbour = <Item>({
  items,
  index,
  offset,
}: {
  readonly items: readonly Item[]
  readonly index: number
  readonly offset: -1 | 1
}): readonly Item[] =>
  pipe(
    Option.all([Arr.get(items, index), Arr.get(items, index + offset)]),
    Option.match({
      onNone: () => items,
      onSome: ([moving, neighbour]) =>
        pipe(items, Arr.replace(index, neighbour), Arr.replace(index + offset, moving)),
    })
  )

/** `items` with list setters that write through `updateItems`. */
const formListOf = <Item>({
  items,
  updateItems,
}: {
  readonly items: readonly Item[]
  readonly updateItems: (edit: (current: readonly Item[]) => readonly Item[]) => void
}): FormList<Item> => {
  const updateAt = (index: number, edit: (item: Item) => Item): void => {
    updateItems((current) => Arr.modify(current, index, edit))
  }
  return {
    items,
    add: (item) => {
      updateItems((current) => [...current, item])
    },
    remove: (index) => {
      updateItems((current) => Arr.remove(current, index))
    },
    update: updateAt,
    move: (index, offset) => {
      updateItems((current) => swapWithNeighbour({ items: current, index, offset }))
    },
    map: (each) =>
      items.map((item, index) =>
        each(
          formStateOf({
            value: item,
            update: (edit) => {
              updateAt(index, edit)
            },
          }),
          index
        )
      ),
  }
}

/** `value` with setters that write through `update`. */
const formStateOf = <S>({
  value,
  update,
}: {
  readonly value: S
  readonly update: (edit: (current: S) => S) => void
}): FormState<S> => ({
  value,
  replace: (next) => {
    update(() => next)
  },
  update,
  set: (key, fieldValue) => {
    update((current) => ({ ...current, [key]: fieldValue }))
  },
  field: (key) =>
    formStateOf({
      value: value[key],
      update: (edit) => {
        update((current) => ({ ...current, [key]: edit(current[key]) }))
      },
    }),
  list<T extends { readonly [P in K]: readonly Item[] }, K extends keyof T, Item = ItemOf<T[K]>>(
    this: FormState<T>,
    key: K
  ): FormList<Item> {
    return formListOf({
      items: this.value[key],
      updateItems: (edit) => {
        this.update((current) => ({ ...current, [key]: edit(current[key]) }))
      },
    })
  },
})

/**
 * A form's state, held by the component, with typed setters for its fields
 * and list fields.
 *
 * @example
 * ```tsx
 * const form = useFormState(() => draftOf(initial))
 * form.set('title', title)
 * form.list('days').add(newDay)
 * form.list('days').map((day) => <DayFieldset key={day.value.key} day={day} />)
 * // in DayFieldset: day.set('label', label); day.list('exercises').move(index, -1)
 * ```
 *
 * @param initial - The state to start from, or a function that makes it on
 *   the first render (as `useState` takes it)
 */
const useFormState = <S>(initial: S | (() => S)): FormState<S> => {
  const [value, setValue] = useState(initial)
  return formStateOf({ value, update: setValue })
}

export { useFormState }
export type { FormList, FormState }
