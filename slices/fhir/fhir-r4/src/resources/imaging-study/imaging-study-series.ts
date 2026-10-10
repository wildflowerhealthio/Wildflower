import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as Coding from '../../data-types/complex/coding.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'
import * as ImagingStudySeriesInstance from './imaging-study-series-instance.ts'

const PerformerStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    function: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    actor: Schema.suspend(() => IdentifierAndReference.ReferenceSchema),
  })
)

const ImagingStudySeriesStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    uid: Schema.String,
    number: OrNullAsOptional(Schema.Number.pipe(Schema.int())),
    modality: Schema.suspend(() => Coding.Schema),
    description: OrNullAsOptional(Schema.String),
    numberOfInstances: OrNullAsOptional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))
    ),
    endpoint: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
      { default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [] }
    ),
    bodySite: OrNullAsOptional(Schema.suspend(() => Coding.Schema)),
    laterality: OrNullAsOptional(Schema.suspend(() => Coding.Schema)),
    specimen: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
      { default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [] }
    ),
    started: OrNullAsOptional(Schema.String),
    performer: Schema.optionalWith(mutableEncoded(Schema.Array(PerformerStruct)), {
      default: (): readonly (typeof PerformerStruct.Type)[] => [],
    }),
    instance: Schema.optionalWith(mutableEncoded(Schema.Array(ImagingStudySeriesInstance.Schema)), {
      default: (): readonly (typeof ImagingStudySeriesInstance.Schema.Type)[] => [],
    }),
  })
)

const ImagingStudySeriesSchema: Schema.Schema<
  typeof ImagingStudySeriesStruct.Type,
  FhirR4.ImagingStudySeries,
  never
> = ImagingStudySeriesStruct

export { ImagingStudySeriesSchema as Schema }
