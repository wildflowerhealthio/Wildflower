import { Schema } from 'effect'

/**
 * `narrowed` as a schema from the decoded fhir-r4 type `From` — the type a
 * `fhir-r4` client or resource schema hands over — so it composes after the
 * resource's own wire schema (`Schema.compose(ServiceRequest.Schema, …)`) and
 * decodes what the app already holds.
 *
 * @remarks
 * The `From` side is declared, not checked: `narrowed` is built on
 * `Schema.typeSchema` of the same fhir-r4 schema, so it already checks every
 * field `From` has, and checking them twice would double the cost of every
 * decode.
 */
const narrowedFrom =
  <From>() =>
  <To, I>(narrowed: Schema.Schema<To, I>): Schema.Schema<To, From> =>
    Schema.compose(
      Schema.declare((_: unknown): _ is From => true),
      narrowed,
      { strict: false }
    )

export { narrowedFrom }
