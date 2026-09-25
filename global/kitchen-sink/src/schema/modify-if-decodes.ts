import { flow, Option, pipe, Schema } from 'effect'

/**
 * An edit on values of `schema`'s type, lifted to untyped input: input that
 * decodes is edited and encoded back, and anything else comes back exactly as
 * it went in.
 *
 * @remarks
 * For untyped passthrough slots (a list of heterogeneous records, a field
 * typed `unknown`) that hold values of several kinds, of which the edit
 * applies to one. The decode is the boundary: the edit only ever sees a typed
 * value, and a value of another kind is never touched.
 *
 * The edited value is encoded before it is written back where the input was,
 * so a schema may decode to a richer shape than the slot stores (an `Option`
 * for a nullable key, say) and the slot still holds its own encoding. An
 * edited value that does not encode is a defect in the edit, and throws.
 */
const modifyIfDecodes = <A, I>(
  schema: Schema.Schema<A, I>,
  edit: (decoded: A) => A
): ((input: unknown) => unknown) => {
  const decode = Schema.decodeUnknownOption(schema)
  const encode = Schema.encodeSync(schema)
  return (input) =>
    pipe(
      decode(input),
      Option.map(flow(edit, encode)),
      Option.getOrElse((): unknown => input)
    )
}

export { modifyIfDecodes }
