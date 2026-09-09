/**
 * Format-agnostic upstream of the anonymizer slice: the picked-file value, the
 * format-descriptor contract, and the routing helpers the shell drives a
 * closed registry with.
 *
 * @packageDocumentation
 */
export { type AnonymizerFormatDescriptor, DecodeFailure } from './format-descriptor.ts'
export { acceptFor, identify } from './identify.ts'
export { type PickedFile } from './picked-file.ts'
