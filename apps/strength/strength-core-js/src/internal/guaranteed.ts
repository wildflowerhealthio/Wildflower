import { Option } from 'effect'

/**
 * The value a narrowed schema guarantees is there.
 *
 * @remarks
 * A getter on a decoded narrowed type reads through a finder that returns an
 * `Option`; the schema admitted the value only because that finder found
 * something, so `None` here means a value that never went through the schema —
 * a defect, not an input error — and throws.
 */
const guaranteed = <A>(found: Option.Option<A>): A =>
  Option.getOrThrowWith(
    found,
    () => new Error('a narrowed value is missing what its schema guarantees; was it decoded?')
  )

export { guaranteed }
