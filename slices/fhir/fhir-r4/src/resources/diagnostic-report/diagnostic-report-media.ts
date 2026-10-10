import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'

// FHIR R4 `DiagnosticReport.media` — a key image or piece of media associated
// with the report. `link` (a `Reference(Media)`) is required (1..1); `comment`
// is an optional free-text explanation of what the media shows.
const DiagnosticReportMediaStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    comment: OrNullAsOptional(Schema.String),
    link: Schema.suspend(() => IdentifierAndReference.ReferenceSchema),
  })
)

const DiagnosticReportMediaSchema: Schema.Schema<
  typeof DiagnosticReportMediaStruct.Type,
  FhirR4.DiagnosticReportMedia,
  never
> = DiagnosticReportMediaStruct

export { DiagnosticReportMediaSchema as Schema }
