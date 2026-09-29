/**
 * The browser half of the synthetic data slice: loading people from a
 * published data set into a FHIR server.
 *
 * @remarks
 * A host app mounts {@link SyntheticDataScreen} under a router whose context
 * carries `fhir-r4-react`'s `runAuthed`; the screen owns everything below it —
 * the data set URL form, the people, the load and its results — and the host
 * owns the data set URL. {@link DEFAULT_DATA_SET_URL} is the published set,
 * and {@link dataSetRootOf} the check a URL passes before it is read.
 * {@link WRITE_ORDER} names the resource types a load orders its writes by,
 * which a host's write scopes must cover; {@link COMPLETE_HEADING} and
 * {@link PARTIAL_HEADING} are the results' headings, for a host's own tests.
 *
 * @packageDocumentation
 */
export { DEFAULT_DATA_SET_URL, dataSetRootOf, InvalidDataSetUrl } from './data-set-url.ts'
export { type Fetch } from './data-set-read.ts'
export { WRITE_ORDER } from './load-plan.ts'
export { COMPLETE_HEADING, PARTIAL_HEADING } from './load-results.tsx'
export { SyntheticDataScreen, type SyntheticDataScreenProps } from './synthetic-data-screen.tsx'
