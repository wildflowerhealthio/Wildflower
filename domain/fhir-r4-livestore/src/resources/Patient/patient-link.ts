import { Schema } from 'effect'

import { BackboneElement, Reference } from '../../data-types/index.ts'
import type { BackboneElementEncoded } from '../../data-types/index.ts'

/**
 * This element is labeled as a modifier because it may be used to mark that the
 * resource was created in error.
 */
const PatientLinkType = Schema.Enums({
  refer: 'refer',
  'replaced-by': 'replaced-by',
  replaces: 'replaces',
  seealso: 'seealso',
} as const)

/** Decoded link type value for a {@link PatientLink}. */
type PatientLinkType = typeof PatientLinkType.Type

const fields = {
  other: Schema.suspend(() => Reference),
  type: PatientLinkType,
} as const satisfies Schema.Struct.Fields

/** Encoded (wire-format) shape of a {@link PatientLink}. */
interface PatientLinkEncoded
  extends Schema.Struct.Encoded<typeof fields>, BackboneElementEncoded<'PatientLink'> {}

/** A link to another Patient resource that concerns the same actual patient. */
class PatientLink extends BackboneElement('PatientLink').extend<PatientLink>('PatientLink')(
  fields
) {}

export { PatientLinkType, PatientLink }
export type { PatientLinkEncoded }
