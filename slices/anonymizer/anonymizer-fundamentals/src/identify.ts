import type { AnonymizerFormatDescriptor } from './format-descriptor.ts'
import type { PickedFile } from './picked-file.ts'

/**
 * The pure routing helpers the shell drives the registry with: which format
 * claims a picked file, and what the picker's `accept` attribute says.
 *
 * @remarks
 * Both are generic over anything descriptor-shaped rather than over
 * {@link AnonymizerFormatDescriptor} itself, so a shell that pairs each
 * descriptor with its panel can route those pairings directly.
 *
 * @packageDocumentation
 */

/**
 * The first registered format whose {@link AnonymizerFormatDescriptor.detect}
 * claims the picked file, or `undefined` when none does.
 *
 * @param descriptors - The registry's descriptors, in registry order
 * @param file - The picked file to identify
 * @returns The claiming descriptor, or `undefined`
 *
 * @remarks
 * First match wins, so registry order is priority order — put formats with
 * crisp magic-byte tests (PDF's `%PDF-`) ahead of looser syntactic ones.
 */
const identify = <D extends Pick<AnonymizerFormatDescriptor<unknown>, 'detect'>>(
  descriptors: readonly D[],
  file: PickedFile
): D | undefined => descriptors.find((descriptor) => descriptor.detect(file))

/**
 * The comma-joined `accept` attribute for a picker offering every registered
 * format.
 *
 * @param descriptors - The registry's descriptors
 * @returns The joined attribute value, duplicates removed in first-seen order
 */
const acceptFor = (
  descriptors: readonly Pick<AnonymizerFormatDescriptor<unknown>, 'accept'>[]
): string => [...new Set(descriptors.flatMap((descriptor) => descriptor.accept))].join(',')

export { acceptFor, identify }
