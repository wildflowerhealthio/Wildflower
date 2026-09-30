/** `parts` end to end in one buffer. */
const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

export { concatBytes }
