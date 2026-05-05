/**
 * RFC 8628 §6.1 user_code generation.
 *
 * Alphabet: 20 unambiguous consonants. 8 chars formatted as "BCDF-GHJK"
 * gives ~1.6 × 10^10 distinct codes — enough that brute-forcing under
 * the 5-minute TTL of an `authorizationRequests` row is infeasible
 * without rate limiting (the device-flow approval endpoint also
 * requires a valid Owner Bearer token).
 *
 * `crypto.getRandomValues` with rejection sampling avoids modulo bias.
 */

const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
const BLOCK_LENGTH = 4
const BLOCK_COUNT = 2
const RAW_LENGTH = BLOCK_LENGTH * BLOCK_COUNT

const sampleAlphabetChar = (): string => {
  const buf = new Uint8Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    const byte = buf[0] ?? 0
    // Reject bytes that would bias the distribution. The largest multiple
    // of ALPHABET.length that fits in a byte is `floor(256 / 20) * 20 = 240`.
    const limit = 256 - (256 % ALPHABET.length)
    if (byte < limit) {
      return ALPHABET[byte % ALPHABET.length] ?? ALPHABET[0]
    }
  }
}

const generateUserCode = (): string => {
  const chars: string[] = []
  for (let i = 0; i < RAW_LENGTH; i++) {
    chars.push(sampleAlphabetChar())
  }
  return `${chars.slice(0, BLOCK_LENGTH).join('')}-${chars.slice(BLOCK_LENGTH).join('')}`
}

const USER_CODE_REGEX = new RegExp(
  `^[${ALPHABET}]{${BLOCK_LENGTH}}-[${ALPHABET}]{${BLOCK_LENGTH}}$`
)

const isValidUserCode = (value: string): boolean => USER_CODE_REGEX.test(value)

export { ALPHABET, generateUserCode, isValidUserCode, BLOCK_LENGTH, BLOCK_COUNT }
