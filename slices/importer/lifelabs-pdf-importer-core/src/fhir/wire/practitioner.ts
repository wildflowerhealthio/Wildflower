import { keyWire, sourceId, type Wire } from './shared.ts'

/** A practitioner is keyed by the name the report prints for them. */
const practitionerOriginalId = (name: string): string => sourceId(['practitioner', name.trim()])

const practitionerWire = (name: string): Wire => ({
  resourceType: 'Practitioner',
  identifier: [keyWire(practitionerOriginalId(name))],
  name: [{ text: name.trim() }],
})

export { practitionerOriginalId, practitionerWire }
