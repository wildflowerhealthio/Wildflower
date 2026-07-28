import type { TraceBody } from 'web-trace-core'

/**
 * What the detail surface can show for a captured body.
 *
 * @remarks
 * Three outcomes, none collapsible into another: text that can be read, bytes
 * that cannot, and a body the capture policy declined to store. A trace is
 * explicit about what it dropped, so the viewer is too.
 */
type BodyText =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'binary'; readonly size: number; readonly contentType: string }
  | { readonly kind: 'skipped'; readonly size: number; readonly reason: string }

/**
 * Base64 to bytes.
 *
 * @remarks
 * `atob` yields a "binary string" — one code unit per byte — so the char codes
 * are the bytes. Going through `TextDecoder` on the string instead would
 * re-interpret those code units as UTF-16 and corrupt every byte above 0x7F.
 */
const bytesOfBase64 = (data: string): Uint8Array =>
  Uint8Array.from(atob(data), (character) => character.charCodeAt(0))

/**
 * Render a captured body for display.
 *
 * @remarks
 * Decoding is `fatal: true` on purpose. A lenient decode replaces undecodable
 * bytes with U+FFFD, which would show a JPEG as a wall of replacement
 * characters and claim it was text — the same lossiness the capture side went
 * out of its way to avoid by storing raw bytes rather than `text()`. A body that
 * is not valid UTF-8 says so instead.
 *
 * Malformed base64 (`atob` throws) is reported as binary rather than raised:
 * this is a viewer, and one unreadable body must not take the surface down.
 *
 * @param body - The exchange's body, stored or skipped
 * @returns What to show, and enough to say why when there is nothing to read
 */
const bodyText = (body: TraceBody): BodyText => {
  if (body._tag === 'SkippedBody') {
    return { kind: 'skipped', size: body.size, reason: body.reason }
  }
  const binary = { kind: 'binary', size: body.size, contentType: body.contentType } as const
  try {
    return {
      kind: 'text',
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytesOfBase64(body.data)),
    }
  } catch {
    return binary
  }
}

export { bodyText, bytesOfBase64, type BodyText }
