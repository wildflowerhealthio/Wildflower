/**
 * Constant-time string comparison. Runs in time proportional to the longer
 * input regardless of length-mismatch or content, so neither the secret's
 * length nor its bytes leak via observable timing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const bufA = encoder.encode(a)
  const bufB = encoder.encode(b)
  const max = Math.max(bufA.length, bufB.length)
  let result = bufA.length ^ bufB.length
  for (let i = 0; i < max; i++) {
    result |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0)
  }
  return result === 0
}

export { timingSafeEqual }
