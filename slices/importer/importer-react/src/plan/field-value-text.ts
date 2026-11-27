/**
 * How the import plan page shows the value of one top-level FHIR field of a
 * resource: the person fields as a reader says them, the common FHIR shapes
 * (narrative, codeable concept, coding, reference, period, quantity) by
 * what they say, and anything else as compact JSON cut short.
 *
 * @packageDocumentation
 */
import { normalizedFieldsOf } from '@wildflowerhealthio/fhir-r4/clients'
import {
  Address,
  ContactPoint,
  HumanName,
  IdentifierAndReference,
} from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, type DateTime, Equal, Match, Option, Record, Schema } from 'effect'

/**
 * A field's value as shown: its text, and, when the text is cut short, the
 * whole of it, for a tooltip.
 */
interface FieldText {
  readonly text: string
  readonly whole: Option.Option<string>
}

/** The longest a value shown as JSON runs before it is cut short. */
const JSON_TEXT_LIMIT = 80

/** The fields whose values are codes a reader compares character by character, shown in mono. */
const MONOSPACED_FIELDS: ReadonlySet<string> = new Set(['identifier'])

/** Whether `field`'s value is shown in mono. */
const isMonospaced = (field: string): boolean => MONOSPACED_FIELDS.has(field)

/** Whether a wire value says something: neither absent nor an empty list, as a difference reads it. */
const hasValue = (value: unknown): boolean =>
  value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)

/**
 * `resource`'s wire value of `field`, as `normalizedEncode` writes it; `None`
 * when it has no value for it.
 */
const valueOf = (resource: FhirResource, field: string): Option.Option<unknown> =>
  normalizedFieldsOf(resource).pipe(
    Option.flatMap((fields) => Record.get(fields, field)),
    Option.filter(hasValue)
  )

/** Each of `parts` that says something, joined by `separator`; `None` when none does. */
const joinedText = (
  parts: readonly (string | null | undefined)[],
  separator: string
): Option.Option<string> =>
  Option.liftPredicate(
    parts
      .filter((part): part is string => part !== null && part !== undefined && part.trim() !== '')
      .join(separator),
    (text) => text !== ''
  )

/** The first of `parts` that says something; `None` when none does. */
const firstText = (parts: readonly (string | null | undefined)[]): Option.Option<string> =>
  Arr.findFirst(parts, (part) => joinedText([part], ''))

/** `text`, then the `use` a value states in brackets, when it states one. */
const withUse = (text: string, use: string | null): string =>
  use === null ? text : `${text} (${use})`

/** A list's items as text joined by `separator`, when the list decodes and every item reads. */
const listText = <A>(
  decoded: Option.Option<readonly A[]>,
  textOfItem: (item: A) => Option.Option<string>,
  separator: string
): Option.Option<string> =>
  Option.flatMap(decoded, (items) =>
    Option.flatMap(Option.all(items.map(textOfItem)), (texts) => joinedText(texts, separator))
  )

const decodeNames = Schema.decodeUnknownOption(Schema.Array(HumanName.Schema))
const decodeAddresses = Schema.decodeUnknownOption(Schema.Array(Address.Schema))
const decodeContactPoints = Schema.decodeUnknownOption(Schema.Array(ContactPoint.Schema))
const decodeIdentifiers = Schema.decodeUnknownOption(
  Schema.Array(IdentifierAndReference.IdentifierSchema)
)
const decodeList = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))

/** A name as it is shown, then its `use` when it states one: "Tyra Banks (official)". */
const nameTextOf = (
  now: DateTime.DateTime,
  name: typeof HumanName.Schema.Type
): Option.Option<string> =>
  Option.map(Option.fromNullable(HumanName.displayName([name], now)), (text) =>
    withUse(text, name.use)
  )

/** An address as one line: its `text`, else its lines, city, state, postal code and country, then its `use`. */
const addressTextOf = (address: typeof Address.Schema.Type): Option.Option<string> =>
  Option.orElse(joinedText([address.text], ''), () =>
    joinedText(
      [...address.line, address.city, address.state, address.postalCode, address.country],
      ', '
    )
  ).pipe(Option.map((text) => withUse(text, address.use)))

/** A contact point as its system and value, then its `use`: "phone 416-555-0100 (home)". */
const contactPointTextOf = (contactPoint: typeof ContactPoint.Schema.Type): Option.Option<string> =>
  Option.map(joinedText([contactPoint.system, contactPoint.value], ' '), (text) =>
    withUse(text, contactPoint.use)
  )

/** One way to read a value of a common FHIR shape as text; `None` when the value is not of it. */
type ShapeReader = (value: unknown) => Option.Option<string>

/** A reader of the values `schema` decodes, read by `textOf`. */
const shapeReader =
  <A, I>(schema: Schema.Schema<A, I>, textOf: (decoded: A) => Option.Option<string>): ShapeReader =>
  (value) =>
    Option.flatMap(Schema.decodeUnknownOption(schema)(value), textOf)

const OptionalString = Schema.optional(Schema.String)

/**
 * The common FHIR shapes, in the order they are tried, each read only when
 * it says something: a string, number or boolean as itself; a Narrative
 * (`div`) as "Narrative"; a CodeableConcept as its `text`, else a coding's
 * `display`, else its `code`; anything else with a `text` as it; a Coding as
 * its `display`, else its `code`; a Reference as its `display`, else its
 * `reference`, else its identifier's value; a Period as its start and end,
 * as stored; a Quantity as its value and unit.
 */
const SHAPE_READERS: readonly ShapeReader[] = [
  shapeReader(Schema.Union(Schema.String, Schema.Number, Schema.Boolean), (scalar) =>
    Option.some(String(scalar))
  ),
  shapeReader(Schema.Struct({ div: Schema.String }), () => Option.some('Narrative')),
  shapeReader(
    Schema.Struct({
      coding: Schema.Array(Schema.Struct({ display: OptionalString, code: OptionalString })),
      text: OptionalString,
    }),
    ({ text, coding }) =>
      Option.orElse(firstText([text]), () =>
        Arr.findFirst(coding, ({ display, code }) => firstText([display, code]))
      )
  ),
  shapeReader(Schema.Struct({ text: Schema.String }), ({ text }) => firstText([text])),
  shapeReader(
    Schema.Struct({ code: Schema.String, display: OptionalString }),
    ({ code, display }) => firstText([display, code])
  ),
  shapeReader(
    Schema.Struct({
      display: OptionalString,
      reference: OptionalString,
      identifier: Schema.optional(Schema.Struct({ value: OptionalString })),
    }),
    ({ display, reference, identifier }) => firstText([display, reference, identifier?.value])
  ),
  shapeReader(Schema.Struct({ start: OptionalString, end: OptionalString }), ({ start, end }) =>
    Option.map(firstText([start, end]), () => `${start ?? ''} – ${end ?? ''}`.trim())
  ),
  shapeReader(Schema.Struct({ value: Schema.Number, unit: OptionalString }), ({ value, unit }) =>
    joinedText([String(value), unit], ' ')
  ),
]

/** `value` as text by the first of {@link SHAPE_READERS} that reads it; `None` when none does. */
const shapeTextOf = (value: unknown): Option.Option<string> =>
  Arr.findFirst(SHAPE_READERS, (read) => read(value))

/** A list of common FHIR shapes as their texts joined; one value as its text. */
const shapesTextOf = (value: unknown): Option.Option<string> =>
  Option.match(decodeList(value), {
    onNone: () => shapeTextOf(value),
    onSome: (items) => listText(Option.some(items), shapeTextOf, ', '),
  })

/** `value` as compact JSON, cut short past {@link JSON_TEXT_LIMIT} characters, the whole kept. */
const jsonTextOf = (value: unknown): FieldText => {
  const json = JSON.stringify(value)
  return json.length <= JSON_TEXT_LIMIT
    ? { text: json, whole: Option.none() }
    : { text: `${json.slice(0, JSON_TEXT_LIMIT - 1)}…`, whole: Option.some(json) }
}

/** "1 extension", "3 extensions". */
const extensionsText = (count: number): string =>
  `${count} ${count === 1 ? 'extension' : 'extensions'}`

/**
 * `value`, the wire value of `field`, as text: a `name` as each name shown,
 * an `address` as its lines, `telecom` as each system and value, each with
 * its `use` when it states one; `identifier` as the values; `extension` as
 * how many there are; any other field by its shape ({@link SHAPE_READERS}),
 * a list's items joined. A value that does not read is compact JSON, cut
 * short.
 */
const textOfValue = (now: DateTime.DateTime, field: string, value: unknown): FieldText =>
  Match.value(field)
    .pipe(
      Match.when('name', () => listText(decodeNames(value), (name) => nameTextOf(now, name), '; ')),
      Match.when('address', () => listText(decodeAddresses(value), addressTextOf, '; ')),
      Match.when('telecom', () => listText(decodeContactPoints(value), contactPointTextOf, ', ')),
      Match.when('identifier', () =>
        listText(decodeIdentifiers(value), ({ value: text }) => Option.fromNullable(text), ', ')
      ),
      Match.when('extension', () =>
        Option.map(decodeList(value), (extensions) => extensionsText(extensions.length))
      ),
      Match.orElse(() => shapesTextOf(value))
    )
    .pipe(
      Option.map((text): FieldText => ({ text, whole: Option.none() })),
      Option.getOrElse(() => jsonTextOf(value))
    )

/** `resource`'s value of `field` as text ({@link textOfValue}); `None` when it has no value for it. */
const textOf = (
  now: DateTime.DateTime,
  resource: FhirResource,
  field: string
): Option.Option<FieldText> =>
  Option.map(valueOf(resource, field), (value) => textOfValue(now, field, value))

/** `resource`'s value of `field` as compact JSON, cut short; `None` when it has no value for it. */
const jsonOf = (resource: FhirResource, field: string): Option.Option<FieldText> =>
  Option.map(valueOf(resource, field), jsonTextOf)

/**
 * Whether `left`'s and `right`'s values of `field` read the same
 * ({@link textOf}): both absent, or the same text, however they differ.
 */
const readAlike = (
  now: DateTime.DateTime,
  field: string,
  left: FhirResource,
  right: FhirResource
): boolean =>
  Equal.equals(
    Option.map(textOf(now, left, field), ({ text }) => text),
    Option.map(textOf(now, right, field), ({ text }) => text)
  )

/**
 * The texts of a field `kept` and `incoming` differ on: each as
 * {@link textOf}, unless they read alike, when each is its JSON, so a
 * reader sees what differs.
 */
const differenceTextsOf = (
  now: DateTime.DateTime,
  field: string,
  kept: FhirResource,
  incoming: FhirResource
): {
  readonly kept: Option.Option<FieldText>
  readonly incoming: Option.Option<FieldText>
} =>
  readAlike(now, field, kept, incoming)
    ? { kept: jsonOf(kept, field), incoming: jsonOf(incoming, field) }
    : { kept: textOf(now, kept, field), incoming: textOf(now, incoming, field) }

export { differenceTextsOf, isMonospaced, jsonOf, readAlike, textOf, textOfValue, valueOf }
export type { FieldText }
