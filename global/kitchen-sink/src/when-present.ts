/**
 * Apply an edit to a slot that may hold no value: a present value is edited,
 * and `null` / `undefined` come back exactly as they went in.
 *
 * @remarks
 * `Option.map` for data that spells absence with `null` / `undefined` (decoded
 * nullable fields, raw wire JSON), so a step that edits a field reads as the
 * edit rather than as the null check around it:
 * `Struct.evolve(order, { shipping: (slot) => whenPresent(slot, withTracking) })`.
 *
 * The result is typed as the slot itself, so a slot typed `A | null` stays
 * `A | null` and never widens to admit `undefined`. There is deliberately no
 * curried form: `Struct.evolve` types each field by the `ReturnType` of its
 * function, which would widen a generic slot type to its constraint.
 */
const whenPresent = <Slot>(
  slot: Slot,
  edit: (value: NonNullable<Slot>) => NonNullable<Slot>
): Slot => (slot === null || slot === undefined ? slot : edit(slot))

export { whenPresent }
