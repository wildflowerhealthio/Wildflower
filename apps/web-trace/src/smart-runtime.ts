import { type FhirR4ResourcesRouterContext } from 'fhir-r4-react'

/**
 * This app's local name for the SMART wiring, which now lives in
 * [`fhir-r4-react/smart`](../../../slices/emr/fhir-r4-react/src/smart/self-hosted-runtime.ts):
 * nothing in it was web-trace-specific, and every self-hosted SMART app needs
 * the same FHIR-base prefixing and bearer attachment.
 */
export { buildSmartRouterContext } from 'fhir-r4-react/smart'

/**
 * The router context `web-trace-react` reads through — this app's instantiation
 * of the shared shape, narrowed to the one slice client it needs.
 */
export type RouterContext = FhirR4ResourcesRouterContext.RouterContext
