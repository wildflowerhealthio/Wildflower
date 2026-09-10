import { DateTime, Effect, Option, ParseResult, Schema } from 'effect'
import { adoptResource } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { LabeledResource } from 'importer-fundamentals'
import { Document } from 'positioned-text'

import * as Report from './entities/report.ts'
import { toFhirResources } from './fhir/to-fhir.ts'
import type { LifeLabsPdfSettings } from './settings.ts'
import { LIFELABS_SYSTEM } from './source-system.ts'

const decodeDocument = Schema.decodeUnknown(Document.FromJson)

const adopt = adoptResource({ system: LIFELABS_SYSTEM })

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
 * Decode a positioned-text JSON file into adopted, labeled FHIR resources —
 * the full pipeline from document text to the review's initial state.
 *
 * @param fileText - The text of a `wildflower-positioned-text` JSON file (what
 *   the PDF anonymizer downloads for a LifeLabs report)
 * @param settings - The import's settings (time zone for date interpretation)
 * @returns The adopted FHIR resources as `LabeledResource`s; fails only with a
 *   `ParseError` when the text is not a positioned-text document or not a
 *   recognized LifeLabs report; requires nothing
 */
const decodeLifeLabsPdf = (
  fileText: string,
  settings: LifeLabsPdfSettings
): Effect.Effect<readonly LabeledResource<FhirResource>[], ParseResult.ParseError> =>
  Effect.gen(function* () {
    const timeZone = yield* checkTimeZone(settings.timeZone)
    const document = yield* decodeDocument(fileText)
    const reports = yield* Report.tryFromDocument(document).pipe(
      Effect.mapError(
        (e) =>
          new ParseResult.ParseError({
            issue: new ParseResult.Type(Schema.String.ast, e, e.message),
          })
      )
    )
    const resources = yield* toFhirResources(reports, { timeZone })
    return resources.map((resource): LabeledResource<FhirResource> => {
      const adopted = adopt(resource)
      const type = adopted.resourceType
      const id = adopted.id ?? '?'
      return { key: `${type}/${id}`, title: `${type}/${id}`, resource: adopted }
    })
  })

export { decodeLifeLabsPdf }
