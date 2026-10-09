import type { SmartHandshake } from 'fhir-r4-react/smart'

/** The SMART client a completed handshake hands the app. */
type SmartClient = Extract<SmartHandshake, { readonly kind: 'ready' }>['client']

export type { SmartClient }
