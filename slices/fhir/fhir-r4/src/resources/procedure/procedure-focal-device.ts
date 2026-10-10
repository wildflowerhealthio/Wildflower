import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'

const ProcedureFocalDeviceStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    action: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    manipulated: Schema.suspend(() => IdentifierAndReference.ReferenceSchema),
  })
)

/**
 * Wire schema for FHIR R4 `Procedure.focalDevice` — a device implanted,
 * removed or otherwise manipulated as the focal portion of the procedure.
 *
 * @remarks
 * `manipulated` (the `Device` reference) is required (1..1); `action` is
 * optional.
 */
const ProcedureFocalDeviceSchema: Schema.Schema<
  typeof ProcedureFocalDeviceStruct.Type,
  FhirR4.ProcedureFocalDevice,
  never
> = ProcedureFocalDeviceStruct

export { ProcedureFocalDeviceSchema as Schema }
