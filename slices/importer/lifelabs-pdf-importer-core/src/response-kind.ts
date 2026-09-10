import { DateTime, Effect, Option, ParseResult, Schema } from 'effect'
import { adoptUnderRecognizedRoot } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import { HttpResponseKind, recognizePortal } from 'http-extraction-fundamentals'
import { Document } from 'positioned-text'

import { LIFELABS_PDF_URL_PREFIX, TIME_ZONE_HEADER } from './decode.ts'
import * as Report from './entities/report.ts'
import { toFhirResources } from './fhir/to-fhir.ts'
import { defaultLifeLabsPdfSettings } from './settings.ts'
import { LIFELABS_SYSTEM } from './source-system.ts'

const decodeDocument = Schema.decodeUnknown(Document.FromJson)

const escapeForRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Exactly the URLs `decodeLifeLabsPdf` mints: the prefix and one file segment. */
const lifeLabsPdfUrl = new RegExp(`^${escapeForRegExp(LIFELABS_PDF_URL_PREFIX)}[^/?#]+$`)

/** The zone a response carries, or the default when the header is absent. */
const timeZoneOf = (headers: readonly (readonly [string, string])[]): string =>
  headers.find(([name]) => name.toLowerCase() === TIME_ZONE_HEADER)?.[1] ??
  defaultLifeLabsPdfSettings.timeZone

/** A zone name the runtime does not know is a parse failure, not a defect. */
const checkTimeZone = (timeZone: string): Effect.Effect<string, ParseResult.ParseError> => {
  if (Option.isSome(DateTime.zoneMakeNamed(timeZone))) return Effect.succeed(timeZone)
  return Effect.fail(
    new ParseResult.ParseError({
      issue: new ParseResult.Type(
        Schema.String.ast,
        timeZone,
        `"${timeZone}" is not an IANA time zone name`
      ),
    })
  )
}

/**
 * The one response kind a LifeLabs positioned-text document is recognized
 * and decoded through: it claims the URL `decodeLifeLabsPdf` mints and parses
 * the body — the document's own JSON — through the dialect and the FHIR
 * synthesis.
 *
 * @remarks
 * Unadopted: `lifeLabsPdfResponseKinds` maps it through
 * `adoptUnderRecognizedRoot` so every resource keys under
 * {@link LIFELABS_SYSTEM}, the identity `tryRecognize` mints here.
 */
const LifeLabsReportResponseKind: HttpResponseKind.HttpResponseKind<FhirResource> =
  HttpResponseKind.make({
    name: 'LifeLabsReportResponseKind',
    tryRecognize: recognizePortal(lifeLabsPdfUrl, LIFELABS_SYSTEM),
    parse: (response) =>
      Effect.gen(function* () {
        const timeZone = yield* checkTimeZone(timeZoneOf(response.headers))
        const document = yield* decodeDocument(response.text())
        return yield* toFhirResources(yield* Report.tryFromDocument(document), { timeZone })
      }),
  })

/** The kind above, adopted so its resources key under the LifeLabs source system. */
const lifeLabsPdfResponseKinds: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = [
  LifeLabsReportResponseKind,
].map(adoptUnderRecognizedRoot)

export { LifeLabsReportResponseKind, lifeLabsPdfResponseKinds }
