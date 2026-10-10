import { Schema } from 'effect'

import { StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as Element from '../base/element.ts'

const NarrativeStatus = Schema.Union(
  Schema.Literal('generated'),
  Schema.Literal('extensions'),
  Schema.Literal('additional'),
  Schema.Literal('empty')
)

const NarrativeStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    div: Schema.String,
    status: NarrativeStatus,
  })
)

const NarrativeSchema: Schema.Schema<typeof NarrativeStruct.Type, FhirR4.Narrative, never> =
  NarrativeStruct

/** The namespace R4 requires on a `Narrative.div`, which is typed `xhtml`. */
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

/**
 * The five characters that would otherwise be read as markup, and the XML
 * entities that spell them as text. `&apos;` is accepted on the way in only:
 * XHTML parses it, but `&#39;` is the spelling every HTML reader also knows.
 */
const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const XML_UNESCAPES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(XML_ESCAPES).map(([char, entity]) => [entity, char])),
  '&apos;': "'",
}

const MARKUP_CHARACTER = new RegExp(`[${Object.keys(XML_ESCAPES).join('')}]`, 'g')
const XML_ENTITY = new RegExp(Object.keys(XML_UNESCAPES).join('|'), 'g')

/** `text` as one XHTML-namespaced `<div>`, with every markup character escaped. */
const divOfText = (text: string): string =>
  `<div xmlns="${XHTML_NAMESPACE}">${text.replace(MARKUP_CHARACTER, (char) => XML_ESCAPES[char] ?? char)}</div>`

/** The text content of a `div`: tags dropped, entities unescaped, whitespace collapsed. */
const textOfDiv = (div: string): string =>
  div
    .replace(/<[^>]*>/g, ' ')
    .replace(XML_ENTITY, (entity) => XML_UNESCAPES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Plain text ⇄ a `Narrative.div`. Decoding reads the text content out of the
 * markup; encoding writes text as a conformant `div`.
 *
 * @remarks
 * R4 types `div` as `xhtml` and requires a single `<div>` in the XHTML
 * namespace, so a bare string is not a legal narrative however readable it
 * looks — a conformant server rejects it on write. Encoding is what a writer
 * uses to produce one; decoding is what a reader uses to display one.
 *
 * Decoding is deliberately crude and lossy: a narrative is free-form, and a
 * server may put a whole generated table in one, which this flattens to a
 * run-on line. Text survives a round trip (encode, then decode) exactly when
 * its whitespace is already collapsed to single spaces and trimmed.
 */
const TextFromDiv = Schema.transform(Schema.String, Schema.String, {
  strict: true,
  decode: textOfDiv,
  encode: divOfText,
})

export { NarrativeSchema as Schema, TextFromDiv }
