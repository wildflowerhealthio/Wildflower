/**
 * A number as a LifeLabs report prints it — the grammar a result and a
 * reference range's bounds share — and its reading.
 *
 * @packageDocumentation
 */

/**
 * A printed number — `8.0`, `-2`, `1,234` (a thousands separator) — as a
 * regular-expression source wrapped in a non-capturing group, so it drops
 * into a larger pattern as one unit without adding a capture.
 */
const PRINTED_NUMBER = String.raw`(?:-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?)`

/**
 * A {@link PRINTED_NUMBER} read as the number it prints. `-0` prints as `-0`
 * but means zero, so the sign is kept out of the value.
 */
const printedNumberValue = (text: string): number => Number(text.replaceAll(',', '')) || 0

export { PRINTED_NUMBER, printedNumberValue }
