import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'

import { LifeLabsIdentifierSystem } from '../../source-system.ts'
import type { Wire } from './shared.ts'

/**
 * A practitioner is keyed by the name the report prints for them, trimmed and
 * with inner whitespace collapsed.
 */
const practitionerKeyOf = (name: string): DetachedResource.Key => ({
  system: LifeLabsIdentifierSystem.PractitionerName,
  value: name.trim().replaceAll(/\s+/g, ' '),
})

const practitionerWire = (name: string): Wire => ({
  resourceType: 'Practitioner',
  identifier: [DetachedResource.keyIdentifierWire(practitionerKeyOf(name))],
  name: [{ text: name.trim() }],
})

export { practitionerKeyOf, practitionerWire }
