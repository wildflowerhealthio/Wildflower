import { Either, Schema } from 'effect'

/** The problem shown under a numeric field whose text spells no number. */
const NOT_A_NUMBER = 'Enter a number'

/** Reads number text, refusing blank text and text that spells no finite number. */
const decodeNumber = Schema.decodeOption(Schema.NumberFromString.pipe(Schema.finite()))

/**
 * A numeric field's text as the number it spells, or the problem to show
 * under it.
 *
 * @remarks
 * Parsing only: whether the number is in range is the `make` it goes to, so a
 * range is never restated here.
 */
const enteredNumber = (text: string): Either.Either<number, string> =>
  Either.fromOption(decodeNumber(text.trim()), () => NOT_A_NUMBER)

/** A number as the text a numeric field starts with. */
const numberText = (value: number): string => String(value)

export { enteredNumber, NOT_A_NUMBER, numberText }
