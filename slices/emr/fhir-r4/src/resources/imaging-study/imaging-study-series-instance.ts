import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as Coding from '../../data-types/complex/coding.ts'

const ImagingStudySeriesInstanceStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    uid: Schema.String,
    sopClass: Schema.suspend(() => Coding.Schema),
    number: OrNullAsOptional(Schema.Number.pipe(Schema.int())),
    title: OrNullAsOptional(Schema.String),
  })
)

const ImagingStudySeriesInstanceSchema: Schema.Schema<
  typeof ImagingStudySeriesInstanceStruct.Type,
  FhirR4.ImagingStudySeriesInstance,
  never
> = ImagingStudySeriesInstanceStruct

export { ImagingStudySeriesInstanceSchema as Schema }
