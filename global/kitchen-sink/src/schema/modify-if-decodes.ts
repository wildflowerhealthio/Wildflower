import { Option, pipe, Schema } from 'effect'

/**
 * An edit on values of `schema`'s type, lifted to untyped input: input that
 * decodes is edited, and anything else comes back exactly as it went in.
 *
 * @remarks
 * For untyped passthrough slots (a list of heterogeneous records, a field
 * typed `unknown`) that hold values of several kinds, of which the edit
 * applies to one. The decode is the boundary: the edit only ever sees a typed
 * value, and a value of another kind is never touched.
 *
 * The schema decodes to the very shape the slot stores (`Schema.Schema<A>` — no
 * transformation between encoded and decoded), because the edited value is
 * written back where the input was.
 */
const modifyIfDecodes = <A>(
  schema: Schema.Schema<A>,
  edit: (decoded: A) => A
): ((input: unknown) => unknown) => {
  const decode = Schema.decodeUnknownOption(schema)
  return (input) =>
    pipe(
      decode(input),
      Option.map(edit),
      Option.getOrElse(() => input)
    )
}

export { modifyIfDecodes }
