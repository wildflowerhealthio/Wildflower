/**
 * Shape detection and same-shape fake generation — the half of the
 * pseudonymizer that decides *what a value looks like* and produces another
 * value that looks the same.
 *
 * @remarks
 * Redaction here is shape-preserving pseudonymization, not a structural
 * skeleton: an ISO date stays an ISO date, a UUID stays a UUID, a phone keeps
 * its punctuation. A collector author reading a redacted trace learns the
 * *shape* of every field — which is what they need to write a parser — without
 * receiving any of the data.
 *
 * Generation is synchronous and driven entirely by a seed, so the caller does
 * one keyed hash per value and expands it here. Every generator satisfies
 * `detectShape(generate(shape, original, seed)) === shape`, which is the
 * property the test suite pins.
 *
 * @packageDocumentation
 */

/**
 * The classes {@link detectShape} sorts a leaf value into.
 *
 * @remarks
 * The classes are ordered from most to least specific inside `detectShape`, and
 * they are mutually exclusive by construction — where two patterns could
 * overlap, the narrower one is tightened until it cannot. `epochMillis` is
 * exactly 13 digits, so `numericId` excludes 13-digit values; `phone` requires a
 * separator or a leading `+`, so a bare run of digits is a `numericId`.
 */
type LeafShape =
  | 'iso8601'
  | 'jwt'
  | 'uuid'
  | 'email'
  | 'currency'
  | 'postalCode'
  | 'phone'
  | 'epochMillis'
  | 'numericId'
  | 'alphanumericId'
  | 'freeText'

const ISO_8601 =
  /^(\d{4})-(\d{2})-(\d{2})(?:([T ])(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CURRENCY = /^[$€£¥]\s?-?\d{1,3}(,\d{3})*(\.\d{2})?$|^-?\d{1,3}(,\d{3})*\.\d{2}$/
const POSTAL_US = /^\d{5}(-\d{4})?$/
// The separator is required. Without it, `K1A0B1` is indistinguishable from any
// other six-character alternating alphanumeric (`a1b2c3`), and claiming postal
// codes for that whole family would be a worse lie than missing the unspaced
// form — which falls through to `alphanumericId` and gets the identical
// character-class-preserving fake anyway.
const POSTAL_CA = /^[A-Za-z]\d[A-Za-z][ -]\d[A-Za-z]\d$/
const PHONE = /^\+?[\d(][\d\s().-]*[\d)]$/
const EPOCH_MILLIS = /^\d{13}$/
const NUMERIC_ID = /^\d+$/
const ALPHANUMERIC_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** Digits in a candidate phone number, the range that separates one from punctuation noise. */
const phoneDigitCount = (value: string): number => value.replace(/\D/g, '').length

/**
 * Sorts a non-empty leaf value into the shape class its fake must imitate.
 *
 * @param value - The leaf's string form
 * @returns The matched class, falling back to `freeText`
 *
 * @remarks
 * The fallback is deliberate: an unrecognized value is still pseudonymized, just
 * with the least structure-preserving generator. Nothing reaches an export
 * unredacted because its shape was not recognized.
 */
const detectShape = (value: string): LeafShape => {
  if (ISO_8601.test(value)) return 'iso8601'
  if (JWT.test(value)) return 'jwt'
  if (UUID.test(value)) return 'uuid'
  if (EMAIL.test(value)) return 'email'
  if (CURRENCY.test(value)) return 'currency'
  if (POSTAL_US.test(value) || POSTAL_CA.test(value)) return 'postalCode'
  if (PHONE.test(value) && /[\s().-]/.test(value) && phoneDigitCount(value) >= 7) return 'phone'
  if (PHONE.test(value) && value.startsWith('+') && phoneDigitCount(value) >= 7) return 'phone'
  if (EPOCH_MILLIS.test(value)) return 'epochMillis'
  if (NUMERIC_ID.test(value)) return 'numericId'
  if (ALPHANUMERIC_ID.test(value)) return 'alphanumericId'
  return 'freeText'
}

/**
 * A deterministic stream of pseudo-random values expanded from a seed.
 *
 * @remarks
 * Generators consume this rather than the raw digest so they never run out of
 * bytes. The algorithm is xoshiro128\*\*: it is not a cryptographic generator
 * and does not need to be — its entire input is one HMAC-SHA-256 digest, and
 * unpredictability comes from the key, not from the expansion.
 */
interface Prng {
  /** Next 32-bit unsigned value. */
  readonly nextUint32: () => number
  /** Uniform integer in `[0, maxExclusive)`. */
  readonly nextInt: (maxExclusive: number) => number
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0

/**
 * Expands digest bytes into a {@link Prng}.
 *
 * @param bytes - At least 16 bytes; the first 16 seed the generator
 * @returns A generator that produces the same stream for the same bytes
 */
const prngFromBytes = (bytes: Uint8Array): Prng => {
  const word = (offset: number): number =>
    (((bytes[offset] ?? 1) << 24) |
      ((bytes[offset + 1] ?? 2) << 16) |
      ((bytes[offset + 2] ?? 3) << 8) |
      (bytes[offset + 3] ?? 4)) >>>
    0
  // An all-zero state is xoshiro's single fixed point; the `|| 1` breaks it.
  let s0 = word(0) || 1
  let s1 = word(4) || 2
  let s2 = word(8) || 3
  let s3 = word(12) || 4

  const nextUint32 = (): number => {
    const result = (Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0) >>> 0
    const t = (s1 << 9) >>> 0
    s2 = (s2 ^ s0) >>> 0
    s3 = (s3 ^ s1) >>> 0
    s1 = (s1 ^ s2) >>> 0
    s0 = (s0 ^ s3) >>> 0
    s2 = (s2 ^ t) >>> 0
    s3 = rotl(s3, 11)
    return result
  }

  return {
    nextUint32,
    nextInt: (maxExclusive: number): number =>
      maxExclusive <= 0 ? 0 : nextUint32() % maxExclusive,
  }
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'
const HEX = '0123456789abcdef'
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const pick = (prng: Prng, alphabet: string): string =>
  alphabet[prng.nextInt(alphabet.length)] ?? alphabet[0] ?? '0'

/**
 * Rewrites each character as a fresh character of the same class — digit for
 * digit, lower for lower, upper for upper — and passes anything else through.
 *
 * @param prng - Source of replacement characters
 * @param source - The value whose character classes are imitated
 * @returns A same-length string with the same class at every position
 *
 * @remarks
 * This is what preserves the *punctuation* of a phone number, the separators of
 * a postal code, and the word lengths of free text, while destroying content.
 * Characters outside the three classes (spaces, `@`, `-`, `.`) are structure and
 * survive; they carry format, not data.
 */
const mapCharClasses = (prng: Prng, source: string): string =>
  Array.from(source, (char) => {
    if (char >= '0' && char <= '9') return pick(prng, DIGITS)
    if (char >= 'a' && char <= 'z') return pick(prng, LOWER)
    if (char >= 'A' && char <= 'Z') return pick(prng, UPPER)
    return char
  }).join('')

/** Same as {@link mapCharClasses}, but never puts a `0` in the leading position. */
const mapCharClassesNoLeadingZero = (prng: Prng, source: string): string => {
  const mapped = mapCharClasses(prng, source)
  if (source[0] !== undefined && source[0] >= '1' && source[0] <= '9') {
    return `${pick(prng, DIGITS.slice(1))}${mapped.slice(1)}`
  }
  return mapped
}

/** A base64url string of exactly `length` characters — used for JWT signatures. */
const fakeBase64Url = (prng: Prng, length: number): string =>
  Array.from({ length }, () => pick(prng, BASE64URL)).join('')

/**
 * The first millisecond that spells as 13 digits (2001-09-09T01:46:40Z), and the
 * width of the 13-digit range that starts there (up to 2033-05-18).
 *
 * @remarks
 * The floor is picked for its *spelling*, not its date: `epochMillis` is defined
 * as exactly thirteen digits, so a fake drawn from before 2001 would come out
 * twelve digits long and be re-read as a `numericId`.
 */
const THIRTEEN_DIGIT_FLOOR = 1_000_000_000_000
const THIRTEEN_DIGIT_SPAN = 999_999_999_999

/**
 * A millisecond instant drawn uniformly from the 13-digit range.
 *
 * @remarks
 * Two draws are combined because one 32-bit word only spans about 50 days —
 * enough to make every fake timestamp cluster in the same seven weeks.
 */
const fakeInstant = (prng: Prng): number => {
  const wide = (prng.nextUint32() % 0x1_0000) * 0x1_0000_0000 + prng.nextUint32()
  return THIRTEEN_DIGIT_FLOOR + (wide % THIRTEEN_DIGIT_SPAN)
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/**
 * Rebuilds an ISO 8601 value around a fake instant, keeping every component the
 * original had and dropping every one it lacked.
 *
 * @remarks
 * The timezone designator is copied verbatim rather than regenerated: `Z` vs
 * `+05:30` is format, and a redacted trace that silently normalized every
 * timestamp to UTC would misinform a collector author about what the API emits.
 */
const fakeIso8601 = (prng: Prng, original: string): string => {
  const parts = ISO_8601.exec(original)
  const instant = new Date(fakeInstant(prng))
  const date = `${pad(instant.getUTCFullYear(), 4)}-${pad(instant.getUTCMonth() + 1, 2)}-${pad(instant.getUTCDate(), 2)}`
  const dateTimeSeparator = parts?.[4]
  if (parts === null || dateTimeSeparator === undefined) return date

  const time = `${pad(instant.getUTCHours(), 2)}:${pad(instant.getUTCMinutes(), 2)}`
  const seconds = parts[7] === undefined ? '' : `:${pad(instant.getUTCSeconds(), 2)}`
  const fraction =
    parts[8] === undefined
      ? ''
      : `.${pad(prng.nextInt(10 ** (parts[8].length - 1)), parts[8].length - 1)}`
  return `${date}${dateTimeSeparator}${time}${seconds}${fraction}${parts[9] ?? ''}`
}

/** A v4-shaped UUID, matching the original's hex case. */
const fakeUuid = (prng: Prng, original: string): string => {
  const hex = (length: number): string => Array.from({ length }, () => pick(prng, HEX)).join('')
  const uuid = `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(prng, '89ab')}${hex(3)}-${hex(12)}`
  return /[A-F]/.test(original) ? uuid.toUpperCase() : uuid
}

/**
 * An email with the original's local-part and domain-label lengths, and its
 * top-level domain.
 *
 * @remarks
 * The TLD survives because it is format, not identity — `.org` vs `.ca` tells a
 * collector author nothing about a person. Everything to the left of it is
 * replaced.
 */
const fakeEmail = (prng: Prng, original: string): string => {
  const at = original.lastIndexOf('@')
  const local = original.slice(0, at)
  const domain = original.slice(at + 1)
  const lastDot = domain.lastIndexOf('.')
  const labels = domain.slice(0, lastDot)
  const tld = domain.slice(lastDot + 1)
  const letters = (length: number): string =>
    Array.from({ length: Math.max(length, 1) }, () => pick(prng, LOWER)).join('')
  return `${letters(local.length)}@${letters(labels.length)}.${tld}`
}

/** Thirteen digits inside the plausible-millisecond window. */
const fakeEpochMillis = (prng: Prng): string => String(fakeInstant(prng))

const generators: Record<LeafShape, (prng: Prng, original: string) => string> = {
  iso8601: fakeIso8601,
  // A JWT's fake is assembled by the engine, which pseudonymizes the payload
  // claims through the same value table so identifiers inside a token still
  // join with identifiers outside it. This entry covers a token whose segments
  // are not decodable JSON.
  jwt: (prng, original) =>
    original
      .split('.')
      .map((segment) => fakeBase64Url(prng, segment.length))
      .join('.'),
  uuid: fakeUuid,
  email: fakeEmail,
  currency: mapCharClassesNoLeadingZero,
  postalCode: mapCharClasses,
  phone: mapCharClasses,
  epochMillis: (prng) => fakeEpochMillis(prng),
  numericId: mapCharClassesNoLeadingZero,
  alphanumericId: mapCharClasses,
  freeText: mapCharClasses,
}

/**
 * Produces a fake of the same shape as `original`.
 *
 * @param shape - The class from {@link detectShape}
 * @param original - The value being replaced, read only for its structure
 * @param seed - Digest bytes; the same bytes always give the same fake
 * @returns A value that `detectShape` sorts into `shape`
 */
const generateFake = (shape: LeafShape, original: string, seed: Uint8Array): string =>
  generators[shape](prngFromBytes(seed), original)

export { detectShape, fakeBase64Url, generateFake, type LeafShape, type Prng, prngFromBytes }
